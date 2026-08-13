import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { Project, ProjectId } from "@matisa/core"
import { classify, isUnder, normalise, worthReporting } from "../modules/discovery/discovery.classify.js"
import {
  appNameAt,
  goModuleName,
  gradleRootProjectName,
  mixAppName,
  pomArtifactId,
  tomlNameInSection
} from "../modules/discovery/discovery.manifest.js"
import {
  descendantsOf,
  parseContainers,
  parseCwds,
  parseHostPorts,
  parseListeners,
  parseProcessTree,
  parseStacks
} from "../modules/discovery/discovery.probes.js"

// Discovery's whole value is telling three things apart that look identical
// from the outside: our own child, the user's app started elsewhere, and a
// stranger. These tests pin that discrimination and the parsing it rests on —
// everything below is pure, so none of it needs a machine with the right
// processes running on it.

const project = (
  over: Omit<Partial<Project>, "id"> & { id: string; name: string; root: string }
): Project =>
  ({
    kind: "process",
    command: { name: "start", program: "pnpm", args: ["dev"] },
    ports: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
    id: over.id as ProjectId
  }) as Project

const api = project({
  id: "api",
  name: "api",
  root: "/dev/api",
  ports: [{ number: 3000, protocol: "tcp" }]
})

const base = {
  projects: [api],
  states: new Map<string, never>(),
  containers: [],
  stacks: [],
  dockerDaemonRunning: false,
  ourPids: new Set<number>()
}

describe("lsof parsing", () => {
  it("folds the process header onto each of its sockets", () => {
    const raw = ["p123", "cnode", "n*:3000", "n127.0.0.1:9229", "p456", "cpostgres", "n*:5432"].join(
      "\n"
    )
    assert.deepEqual(parseListeners(raw), [
      { pid: 123, command: "node", address: "*:3000", port: 3000 },
      { pid: 123, command: "node", address: "127.0.0.1:9229", port: 9229 },
      { pid: 456, command: "postgres", address: "*:5432", port: 5432 }
    ])
  })

  it("keeps IPv6 binds and drops established connections", () => {
    const raw = ["p7", "cnode", "n[::1]:5173", "n1.2.3.4:80->5.6.7.8:443"].join("\n")
    assert.deepEqual(parseListeners(raw), [
      { pid: 7, command: "node", address: "[::1]:5173", port: 5173 }
    ])
  })

  it("does not carry a command name across a process boundary", () => {
    // lsof omits `c` for some processes; the previous block's name must not
    // leak onto them, or the row is confidently mislabelled.
    const raw = ["p1", "cnode", "n*:3000", "p2", "n*:4000"].join("\n")
    assert.deepEqual(parseListeners(raw).map((r) => r.command), ["node", "?"])
  })

  it("walks the process tree down from a root", () => {
    // pid ppid — 100 is the engine, 200 its caddy, 300 caddy's worker, 900 a
    // stranger that happens to sit next to them in the table.
    const raw = ["  1     0", "100     1", "200   100", "300   200", "900     1"].join("\n")
    const tree = descendantsOf(parseProcessTree(raw), 100)
    assert.deepEqual([...tree].sort((a, b) => a - b), [100, 200, 300])
  })

  it("does not hang on a cycle in the reported table", () => {
    // `ps` should never report one, but a walk that trusted it would spin
    // forever inside a user-triggered request.
    const tree = descendantsOf(parseProcessTree(["10 20", "20 10"].join("\n")), 10)
    assert.deepEqual([...tree].sort((a, b) => a - b), [10, 20])
  })

  it("reads one cwd per pid", () => {
    const raw = ["p123", "n/dev/api", "p456", "n/dev/web"].join("\n")
    assert.deepEqual([...parseCwds(raw)], [
      [123, "/dev/api"],
      [456, "/dev/web"]
    ])
  })
})

describe("docker parsing", () => {
  it("takes only mapped host ports", () => {
    assert.deepEqual(parseHostPorts("0.0.0.0:5432->5432/tcp, :::5432->5432/tcp"), [5432])
    // No arrow means the port is exposed inside the network only — nothing on
    // the host is bound, so nothing can conflict with a project's port.
    assert.deepEqual(parseHostPorts("8080/tcp"), [])
  })

  it("parses the container table", () => {
    const raw = "abc123\tapi-db-1\tpostgres:16\trunning\tUp 2 hours\t0.0.0.0:5432->5432/tcp"
    assert.deepEqual(parseContainers(raw), [
      {
        id: "abc123",
        name: "api-db-1",
        image: "postgres:16",
        state: "running",
        status: "Up 2 hours",
        hostPorts: [5432]
      }
    ])
  })

  it("survives compose ls returning junk", () => {
    assert.deepEqual(parseStacks("not json"), [])
    assert.deepEqual(parseStacks(""), [])
    assert.deepEqual(parseStacks('[{"Name":"api","Status":"running(2)","ConfigFiles":"/dev/api/c.yml"}]'), [
      { name: "api", status: "running(2)", configFiles: "/dev/api/c.yml" }
    ])
  })
})

describe("isUnder", () => {
  it("matches the root itself and anything below it", () => {
    assert.equal(isUnder("/dev/api", "/dev/api"), true)
    assert.equal(isUnder("/dev/api/packages/server", "/dev/api"), true)
    assert.equal(isUnder("/dev/api/", "/dev/api"), true)
  })

  it("does not treat a sibling with a shared prefix as a child", () => {
    assert.equal(isUnder("/dev/api-v2", "/dev/api"), false)
    assert.equal(isUnder("/dev", "/dev/api"), false)
  })
})

describe("normalise", () => {
  it("strips a trailing version so interpreters match their family", () => {
    assert.equal(normalise("Python3.12"), "python")
    assert.equal(normalise("php8.2"), "php")
    assert.equal(normalise("/usr/local/bin/node"), "node")
  })

  it("leaves a name that merely ends in a letter alone", () => {
    assert.equal(normalise("beam.smp"), "beam.smp")
    assert.equal(normalise("next-server"), "next-server")
  })
})

describe("worthReporting", () => {
  const row = (command: string, port: number, appName?: string) => ({
    pid: 1,
    command,
    address: "*",
    port,
    ...(appName === undefined ? {} : { appName })
  })

  it("keeps dev runtimes on any port", () => {
    assert.equal(worthReporting(row("node", 61234)), true)
    assert.equal(worthReporting(row("Python3.12", 61234)), true)
    assert.equal(worthReporting(row("beam.smp", 61234)), true)
  })

  it("keeps a compiled binary purely because it runs from a project root", () => {
    // The whole point of the manifest signal: `./api` is a name no command
    // list can anticipate, and 61234 is in no dev port range.
    assert.equal(worthReporting(row("api", 61234)), false)
    assert.equal(worthReporting(row("api", 61234, "api")), true)
  })

  it("keeps unknown commands sitting on dev ports", () => {
    assert.equal(worthReporting(row("myserver", 3000)), true)
  })

  it("drops system noise", () => {
    assert.equal(worthReporting(row("mDNSResponder", 5353)), false)
    assert.equal(worthReporting(row("sshd", 22)), false)
  })

  it("drops macOS daemons even when they sit on a dev port", () => {
    // AirPlay Receiver binds both of these. The port is what makes them look
    // interesting, so the name has to be what rules them out.
    assert.equal(worthReporting(row("ControlCenter", 5000)), false)
    assert.equal(worthReporting(row("ControlCe", 7000)), false)
  })

  it("does not match a dev command as a substring of a system one", () => {
    // `air` (the Go live-reloader) vs macOS `airportd`; `go` vs `mongod`. Both
    // were false positives while the list was matched with `includes`.
    assert.equal(worthReporting(row("airportd", 61234)), false)
    assert.equal(worthReporting(row("mongod", 61234)), false)
    assert.equal(worthReporting(row("air", 61234)), true)
  })
})

describe("classify — whose process is it", () => {
  it("claims a project whose port is held from inside its own root", () => {
    const { claims, unmanaged } = classify({
      ...base,
      listeners: [{ pid: 900, command: "node", address: "*:3000", port: 3000, cwd: "/dev/api" }]
    })
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.evidence, "root")
    assert.equal(claims[0]?.projectId, "api")
    assert.match(claims[0]?.message ?? "", /started outside matisa/)
    // Claimed, therefore accounted for — it must not also appear as a stranger.
    assert.deepEqual(unmanaged, [])
  })

  it("claims with weak evidence when the holder lives somewhere else", () => {
    const { claims } = classify({
      ...base,
      listeners: [{ pid: 900, command: "python3", address: "*:3000", port: 3000, cwd: "/tmp/other" }]
    })
    assert.equal(claims[0]?.evidence, "port")
    assert.match(claims[0]?.message ?? "", /not api's directory/)
  })

  it("still claims when the cwd is unreadable, on port evidence alone", () => {
    const { claims } = classify({
      ...base,
      listeners: [{ pid: 900, command: "node", address: "*:3000", port: 3000 }]
    })
    assert.equal(claims[0]?.evidence, "port")
  })

  it("never claims against a project the engine is running", () => {
    const { claims, unmanaged } = classify({
      ...base,
      states: new Map([["api", "running" as const]]),
      listeners: [{ pid: 900, command: "node", address: "*:3000", port: 3000, cwd: "/dev/api" }]
    })
    assert.deepEqual(claims, [])
    assert.deepEqual(unmanaged, [])
  })

  it("never reports our own spawned pid as unmanaged", () => {
    const { unmanaged } = classify({
      ...base,
      ourPids: new Set([900]),
      listeners: [{ pid: 900, command: "node", address: "*:4321", port: 4321, cwd: "/dev/other" }]
    })
    assert.deepEqual(unmanaged, [])
  })

  it("reports a stranger once, named from its manifest", () => {
    const { unmanaged } = classify({
      ...base,
      listeners: [
        { pid: 900, command: "node", address: "*:5173", port: 5173, cwd: "/dev/web", appName: "web-ui" },
        { pid: 900, command: "node", address: "*:5174", port: 5174, cwd: "/dev/web", appName: "web-ui" }
      ]
    })
    assert.equal(unmanaged.length, 1)
    assert.deepEqual(
      { ref: unmanaged[0]?.ref, name: unmanaged[0]?.displayName, port: unmanaged[0]?.port },
      { ref: "pid:900", name: "web-ui", port: 5173 }
    )
  })

  it("ignores docker entirely while the daemon is down", () => {
    const { unmanaged } = classify({
      ...base,
      listeners: [],
      dockerDaemonRunning: false,
      containers: [
        { id: "a", name: "stray", image: "redis", state: "running", status: "Up", hostPorts: [6379] }
      ]
    })
    assert.deepEqual(unmanaged, [])
  })

  it("claims a docker project's container and hides matisa's own from the stranger list", () => {
    const dockerProject = project({
      id: "cache",
      name: "cache",
      root: "/dev/cache",
      kind: "docker",
      image: "redis:7"
    })
    const { claims, unmanaged } = classify({
      ...base,
      projects: [dockerProject],
      listeners: [],
      dockerDaemonRunning: true,
      containers: [
        { id: "a", name: "matisa.cache", image: "redis:7", state: "running", status: "Up", hostPorts: [6379] },
        { id: "b", name: "matisa.gone", image: "redis:7", state: "running", status: "Up", hostPorts: [] },
        { id: "c", name: "someones-db", image: "postgres:16", state: "exited", status: "Exited", hostPorts: [] }
      ]
    })
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.evidence, "container")
    assert.equal(claims[0]?.holder, "matisa.cache")
    // `matisa.gone` has no catalog entry any more, but a leftover of ours is
    // still not a stranger's container to list.
    assert.deepEqual(
      unmanaged.map((u) => u.ref),
      ["container:someones-db"]
    )
  })

  it("folds a known stack's containers into the stack, not the stranger list", () => {
    const stackProject = project({
      id: "shop",
      name: "shop",
      root: "/dev/shop",
      kind: "compose",
      composeFile: "/dev/shop/docker-compose.yml"
    })
    const { claims, unmanaged } = classify({
      ...base,
      projects: [stackProject],
      listeners: [],
      dockerDaemonRunning: true,
      stacks: [
        { name: "shop-stack", status: "running(3)", configFiles: "/dev/shop/docker-compose.yml" }
      ],
      containers: [
        { id: "a", name: "shop-stack-web-1", image: "web", state: "running", status: "Up", hostPorts: [8080] },
        { id: "b", name: "shop-stack-db-1", image: "pg", state: "running", status: "Up", hostPorts: [5432] }
      ]
    })
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.holder, "shop-stack")
    assert.deepEqual(unmanaged, [])
  })

  it("sorts running things above stopped ones", () => {
    const { unmanaged } = classify({
      ...base,
      listeners: [],
      dockerDaemonRunning: true,
      containers: [
        { id: "a", name: "z-stopped", image: "i", state: "exited", status: "", hostPorts: [1] },
        { id: "b", name: "a-running", image: "i", state: "running", status: "", hostPorts: [2] }
      ]
    })
    assert.deepEqual(unmanaged.map((u) => u.displayName), ["a-running", "z-stopped"])
  })
})

describe("manifest names", () => {
  it("reads a name out of the requested TOML section only", () => {
    const raw = ['[tool.other]', 'name = "wrong"', "[package]", 'name = "right"  # trailing'].join("\n")
    assert.equal(tomlNameInSection(raw, "package"), "right")
    assert.equal(tomlNameInSection(raw, "project"), undefined)
  })

  it("takes the last segment of a go module path", () => {
    assert.equal(goModuleName("module github.com/me/api\n\ngo 1.22\n"), "api")
    assert.equal(goModuleName("go 1.22"), undefined)
  })

  it("takes the OTP application atom from mix.exs", () => {
    const raw = ["defmodule App.MixProject do", "  def project do", "    [app: :my_app,", "     version: \"0.1.0\"]"].join("\n")
    assert.equal(mixAppName(raw), "my_app")
    assert.equal(mixAppName("defmodule X do\nend"), undefined)
  })

  it("skips the parent POM's artifactId", () => {
    // A multi-module build would otherwise label every module with the parent's
    // name, which is worse than no name at all.
    const raw = [
      "<project>",
      "  <parent><groupId>com.me</groupId><artifactId>platform</artifactId></parent>",
      "  <artifactId>orders-api</artifactId>",
      "</project>"
    ].join("\n")
    assert.equal(pomArtifactId(raw), "orders-api")
  })

  it("reads gradle's name from settings, in either DSL", () => {
    assert.equal(gradleRootProjectName('rootProject.name = "billing"'), "billing")
    assert.equal(gradleRootProjectName("rootProject.name = 'billing'"), "billing")
    assert.equal(gradleRootProjectName("plugins { id 'java' }"), undefined)
  })
})

describe("appNameAt — the two manifest tiers", () => {
  const root = mkdtempSync(join(tmpdir(), "matisa-manifest-"))
  const at = (...parts: ReadonlyArray<string>): string => join(root, ...parts)
  const write = (dir: string, file: string, body = ""): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), body)
  }
  after(() => rmSync(root, { recursive: true, force: true }))

  it("prefers a declared name, and keeps an npm scope", () => {
    // The scope is usually the monorepo the package belongs to, and it is what
    // distinguishes one `desktop` from another in a flat list.
    write(at("js"), "package.json", '{"name":"@scope/api"}')
    assert.equal(appNameAt(at("js")), "@scope/api")
  })

  it("drops a composer vendor prefix", () => {
    // Unlike an npm scope, the vendor half is publishing metadata — nobody
    // calls the service "symfony/console".
    write(at("php"), "composer.json", '{"name":"acme/billing"}')
    assert.equal(appNameAt(at("php")), "billing")
  })

  it("falls back to the directory when the manifest names nothing", () => {
    // Ruby is the reason this tier exists: a Rails app declares its name
    // nowhere a shallow reader can reach, but the Gemfile still proves it is a
    // project — which is what earns the right to use the directory as a label.
    write(at("checkout-svc"), "Gemfile", "source 'https://rubygems.org'")
    assert.equal(appNameAt(at("checkout-svc")), "checkout-svc")
  })

  it("takes the name off a filename when that is where it lives", () => {
    write(at("dotnet"), "Orders.Api.csproj", "<Project/>")
    assert.equal(appNameAt(at("dotnet")), "Orders.Api")
    write(at("rb"), "payments.gemspec", "")
    assert.equal(appNameAt(at("rb")), "payments")
  })

  it("walks up to the project root from a subdirectory", () => {
    write(at("mono"), "package.json", '{"name":"mono"}')
    mkdirSync(at("mono", "a", "b"), { recursive: true })
    assert.equal(appNameAt(at("mono", "a", "b")), "mono")
  })

  it("returns nothing outside a project", () => {
    mkdirSync(at("bare"), { recursive: true })
    assert.equal(appNameAt(at("bare")), undefined)
  })

  it("never treats / or $HOME as a project root", () => {
    // A stray package.json in $HOME would otherwise make every daemon whose cwd
    // is home — which is most of them — look like the user's own application.
    assert.equal(appNameAt("/"), undefined)
    assert.equal(appNameAt(homedir()), undefined)
  })
})
