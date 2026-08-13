import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as http from "node:http"
import * as net from "node:net"
import { Effect, Exit } from "effect"
import { ProjectId } from "@matisa/core"
import {
  bootstrapConfig,
  desiredConfig,
  loopbackPortFree,
  makeAdmin,
  ownerId,
  routeFor,
  selectLoopbackPort,
  selectWildcardPort,
  slugify,
  wildcardPortFree,
  type RouteSpec
} from "../modules/exposure/exposure.caddy.js"

// The Caddy config is a pure projection of the store — these tests pin the
// derivation: hostnames, upstream dials, the always-loopback shared listener,
// and the dedicated per-project LAN listeners. Port selection is tested against
// real sockets, because the bug it exists to prevent (a port free in one address
// family and taken in the other) only shows up in a real bind.

const OPTS = {
  adminPort: 2019,
  httpPort: 7777,
  mdnsDomain: "matisa.local",
  ownerToken: "tok"
}

const spec = (over: Partial<RouteSpec> = {}): RouteSpec => ({
  projectId: ProjectId.make("p1"),
  slug: "my-api",
  upstreamPort: 3000,
  ...over
})

type Route = {
  "@id": string
  match?: Array<{ host: Array<string> }>
  handle: Array<Record<string, unknown>>
}
type Servers = Record<string, { listen: Array<string>; routes: Array<Route> }>
const httpApp = (cfg: Record<string, unknown>) =>
  cfg["apps"] as { http: { "@id": string; servers: Servers } }
const serversOf = (cfg: Record<string, unknown>): Servers => httpApp(cfg).http.servers

describe("slugify", () => {
  it("lowercases and collapses non-alphanumerics", () => {
    assert.equal(slugify("My API (v2)"), "my-api-v2")
  })
  it("trims leading/trailing separators", () => {
    assert.equal(slugify("  spaced out  "), "spaced-out")
  })
})

describe("routeFor", () => {
  it("stable-only: one .localhost host, tagged with the project id", () => {
    const route = routeFor(spec()) as {
      "@id": string
      match: Array<{ host: Array<string> }>
      handle: Array<{ handler: string; upstreams: Array<{ dial: string }> }>
    }
    assert.equal(route["@id"], "matisa:p1")
    assert.deepEqual(route.match[0]?.host, ["my-api.localhost"])
    assert.equal(route.handle[0]?.upstreams[0]?.dial, "127.0.0.1:3000")
  })

  it("lan does NOT add the mDNS host to the shared (loopback) route", () => {
    const route = routeFor(spec({ lan: { lanPort: 7801 } })) as {
      match: Array<{ host: Array<string> }>
    }
    assert.deepEqual(route.match[0]?.host, ["my-api.localhost"])
  })
})

const shared = (specs: ReadonlyArray<RouteSpec>) => serversOf(desiredConfig(specs, OPTS))["matisa"]

const lanSpec = spec({
  projectId: ProjectId.make("p2"),
  slug: "web",
  upstreamPort: 5173,
  lan: { lanPort: 7801 }
})

describe("desiredConfig", () => {
  it("no specs → only the 404 fallback route, loopback listener", () => {
    assert.deepEqual(shared([])?.listen, ["127.0.0.1:7777", "[::1]:7777"])
    assert.deepEqual(
      shared([])?.routes.map((r) => r["@id"]),
      ["matisa:fallback"]
    )
  })

  it("fallback 404 route is last, after every project route", () => {
    assert.deepEqual(
      shared([spec()])?.routes.map((r) => r["@id"]),
      ["matisa:p1", "matisa:fallback"]
    )
  })

  it("shared listener binds BOTH loopback families so localhost cannot split", () => {
    assert.deepEqual(shared([spec()])?.listen, ["127.0.0.1:7777", "[::1]:7777"])
  })

  it("a LAN row NEVER rebinds the shared listener — only adds a dedicated one", () => {
    const servers = serversOf(desiredConfig([spec(), lanSpec], OPTS))
    assert.deepEqual(servers["matisa"]?.listen, ["127.0.0.1:7777", "[::1]:7777"])
    assert.deepEqual(servers["matisa_lan_p2"]?.listen, ["0.0.0.0:7801"])
    assert.deepEqual(Object.keys(servers), ["matisa", "matisa_lan_p2"])
  })

  it("the dedicated listener proxies its own project hostless (bare IP works)", () => {
    const server = serversOf(desiredConfig([lanSpec], OPTS))["matisa_lan_p2"]
    const proxy = server?.routes.at(-1)
    assert.equal(proxy?.["@id"], "matisa:lan:p2")
    assert.equal(proxy?.match, undefined)
    assert.deepEqual(proxy?.handle[0]?.["upstreams"], [{ dial: "127.0.0.1:5173" }])
  })

  it("the dedicated listener refuses other projects' hostnames deliberately", () => {
    const server = serversOf(desiredConfig([spec(), lanSpec], OPTS))["matisa_lan_p2"]
    const deny = server?.routes[0]
    assert.equal(deny?.["@id"], "matisa:lan:p2:deny")
    // The un-shared project is denied by NAME on the LAN port, not left to a
    // 502 from a proxy attempt that happens to fail.
    assert.deepEqual(deny?.match?.[0]?.host, ["my-api.localhost", "my-api.matisa.local"])
    assert.equal(deny?.handle[0]?.["status_code"], 404)
  })

  it("no other projects → no deny route to emit", () => {
    const server = serversOf(desiredConfig([lanSpec], OPTS))["matisa_lan_p2"]
    assert.deepEqual(
      server?.routes.map((r) => r["@id"]),
      ["matisa:lan:p2"]
    )
  })

  it("admin endpoint is loopback-only in both bootstrap and desired configs", () => {
    assert.equal(
      (bootstrapConfig(2019, "tok")["admin"] as { listen: string }).listen,
      "127.0.0.1:2019"
    )
    assert.equal(
      (desiredConfig([], OPTS)["admin"] as { listen: string }).listen,
      "127.0.0.1:2019"
    )
  })

  it("the ownership marker survives from bootstrap into the pushed config", () => {
    assert.equal(httpApp(bootstrapConfig(2019, "tok")).http["@id"], ownerId("tok"))
    assert.equal(httpApp(desiredConfig([], OPTS)).http["@id"], ownerId("tok"))
  })
})

// ——— port selection (real sockets) ———

const withListener = async (
  host: string,
  port: number,
  body: () => Promise<void>
): Promise<void> => {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host, port }, resolve)
  })
  try {
    await body()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** A port high enough that nothing on a dev machine is likely to hold it. */
const BASE = 43110

describe("selectLoopbackPort", () => {
  it("takes the preferred port when it is free in both families", async () => {
    assert.equal(await Effect.runPromise(selectLoopbackPort(BASE)), BASE)
  })

  it("steps up past a port held on IPv4 loopback only", async () => {
    // The whole point: 127.0.0.1 taken while ::1 is free is the split-brain
    // case, and a wildcard bind test would have called this port free.
    await withListener("127.0.0.1", BASE + 1, async () => {
      assert.equal(await Effect.runPromise(loopbackPortFree(BASE + 1)), false)
      assert.equal(await Effect.runPromise(selectLoopbackPort(BASE + 1)), BASE + 2)
    })
  })

  it("steps up past a port held on IPv6 loopback only", async () => {
    await withListener("::1", BASE + 3, async () => {
      assert.equal(await Effect.runPromise(selectLoopbackPort(BASE + 3)), BASE + 4)
    })
  })

  it("skips excluded ports so the two caddy listeners cannot collide", async () => {
    assert.equal(
      await Effect.runPromise(selectLoopbackPort(BASE + 5, { exclude: [BASE + 5] })),
      BASE + 6
    )
  })

  it("is deterministic — the same machine state gives the same port", async () => {
    const first = await Effect.runPromise(selectLoopbackPort(BASE + 7))
    const second = await Effect.runPromise(selectLoopbackPort(BASE + 7))
    assert.equal(first, second)
  })

  it("undefined when the whole span is taken (caller degrades, never crashes)", async () => {
    await withListener("127.0.0.1", BASE + 9, async () => {
      assert.equal(
        await Effect.runPromise(selectLoopbackPort(BASE + 9, { span: 1 })),
        undefined
      )
    })
  })
})

// ——— the ownership gate ———

/** A stand-in admin endpoint: `marker` is the `@id` it will admit to owning
 * (undefined = a caddy that never saw ours), and every /load it receives is
 * recorded so a refusal can be proven to be a refusal. */
const fakeAdmin = async (
  marker: string | undefined
): Promise<{ port: number; loads: Array<string>; close: () => Promise<void> }> => {
  const loads: Array<string> = []
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/id/") === true) {
      if (marker === undefined) {
        res.writeHead(404).end("unknown object id")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ "@id": marker, servers: {} }))
      return
    }
    let body = ""
    req.on("data", (c: Buffer) => (body += c.toString()))
    req.on("end", () => {
      loads.push(body)
      res.writeHead(200).end()
    })
  })
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  return { port, loads, close: () => new Promise<void>((r) => server.close(() => r())) }
}

// A LAN listener binds 0.0.0.0, so that is the address its port has to be free
// on. The two probes are deliberately different questions, and the gap between
// them is load-bearing in both directions.
describe("selectWildcardPort — LAN listener ports", () => {
  const LAN = BASE + 300

  it("takes the preferred port when the wildcard address is free", async () => {
    assert.equal(await Effect.runPromise(selectWildcardPort(LAN)), LAN)
  })

  it("steps up past a port already held on the wildcard address", async () => {
    await withListener("0.0.0.0", LAN + 1, async () => {
      assert.equal(await Effect.runPromise(wildcardPortFree(LAN + 1)), false)
      assert.equal(await Effect.runPromise(selectWildcardPort(LAN + 1)), LAN + 2)
    })
  })

  it("does NOT consider caddy's loopback-only ports taken — they are excluded by the caller", async () => {
    // The reason `allocateLanPort` passes them in `exclude`: a listener on
    // 127.0.0.1 leaves 0.0.0.0 bindable, so probing alone would hand a LAN
    // listener the port caddy already serves stable URLs on, and Caddy would be
    // asked to listen twice on one port.
    await withListener("127.0.0.1", LAN + 4, async () => {
      assert.equal(await Effect.runPromise(wildcardPortFree(LAN + 4)), true)
      assert.equal(
        await Effect.runPromise(selectWildcardPort(LAN + 4, { exclude: [LAN + 4] })),
        LAN + 5
      )
    })
  })

  it("reuses a released port instead of climbing past it", async () => {
    // `Math.max(used) + 1` walked away from the base forever; probing means a
    // project that stops sharing gives its port back.
    assert.equal(await Effect.runPromise(selectWildcardPort(LAN + 7, { exclude: [LAN + 8] })), LAN + 7)
  })

  it("undefined when the span is exhausted, so the toggle can refuse cleanly", async () => {
    await withListener("0.0.0.0", LAN + 10, async () => {
      assert.equal(
        await Effect.runPromise(selectWildcardPort(LAN + 10, { span: 1 })),
        undefined
      )
    })
  })
})

describe("makeAdmin — ownership gate", () => {
  it("loads when the endpoint reports our marker", async () => {
    const admin = await fakeAdmin(ownerId("tok"))
    try {
      await Effect.runPromise(makeAdmin(admin.port, "tok").load({ hello: "world" }))
      assert.deepEqual(admin.loads, ['{"hello":"world"}'])
    } finally {
      await admin.close()
    }
  })

  it("never POSTs to a caddy that does not carry our marker", async () => {
    // The dangerous case: someone else's caddy on the port we picked. A config
    // push here would rewrite a stranger's web server.
    const admin = await fakeAdmin(ownerId("someone-else"))
    try {
      const exit = await Effect.runPromiseExit(makeAdmin(admin.port, "tok").load({ a: 1 }))
      assert.equal(Exit.isFailure(exit), true)
      assert.deepEqual(admin.loads, [])
    } finally {
      await admin.close()
    }
  })

  it("treats an unknown-id 404 as foreign, not as ours", async () => {
    const admin = await fakeAdmin(undefined)
    try {
      assert.equal(await Effect.runPromise(makeAdmin(admin.port, "tok").ownership()), "foreign")
      assert.deepEqual(admin.loads, [])
    } finally {
      await admin.close()
    }
  })

  it("nothing listening is `unreachable` — a retry, not a hijack", async () => {
    const port = await Effect.runPromise(selectLoopbackPort(BASE + 11))
    assert.notEqual(port, undefined)
    assert.equal(
      await Effect.runPromise(makeAdmin(port ?? 0, "tok").ownership()),
      "unreachable"
    )
  })
})
