import { sep } from "node:path"
import type {
  DiscoveredContainer,
  DiscoveredStack,
  ForeignClaim,
  ListeningPort,
  Project,
  ProjectId,
  RuntimeState,
  UnmanagedEntry
} from "@matisa/core"
import { CONTAINER_PREFIX, containerName } from "../docker/docker.actions.js"

// ────────────────────────────────────────────────────────────────────────────
// The pure half of discovery: probe output in, claims and unmanaged rows out.
// No syscalls, no I/O, no clock — every input a caller had to go and fetch is
// passed in, so the interesting decisions are unit-testable without a machine
// that happens to have the right things running on it.
//
// Two rules do the real work.
//
// `isUnder` decides ownership by directory. A pid whose working directory sits
// inside a project's root IS that project, no matter who started it — which is
// exactly the case the old app could only report as an anonymous "something is
// on your port". It compares path prefixes with a separator guard so
// `/dev/api-v2` is never mistaken for a child of `/dev/api`.
//
// `worthReporting` decides what is worth SHOWING among everything else. The
// machine has dozens of listeners (mDNSResponder, the SSH agent, Docker's own
// proxy); surfacing all of them would bury the three that matter. A row is kept
// when it runs from a directory carrying a project manifest, when its command
// is a known dev runtime, or — last and weakest — when its port sits in a range
// people put dev servers on.
// ────────────────────────────────────────────────────────────────────────────

/** Process names that mean "someone is running an application here".
 *
 *  Matched EXACTLY, against a normalised command (see `normalise`), never as a
 *  substring. Substring matching is what made `air` — the Go live-reloader —
 *  also match macOS's `airportd`, and `go` unusable entirely because it appears
 *  inside `mongod` and `google`. Exactness costs a little coverage on oddly
 *  named binaries, which is precisely the case the manifest signal now
 *  handles. */
const DEV_COMMANDS: ReadonlySet<string> = new Set([
  // JS/TS
  "node", "bun", "deno", "vite", "next-server", "next", "nodemon", "tsx", "ts-node",
  "webpack", "esbuild",
  // Python
  "python", "gunicorn", "uvicorn", "hypercorn", "celery", "flask", "django-admin",
  // Ruby
  "ruby", "rails", "puma", "unicorn", "rackup", "sidekiq", "bundle", "rake", "thin",
  // Rust / Go / Zig / Crystal
  "cargo", "air", "go", "zig", "crystal",
  // JVM
  "java", "gradle", "mvn", "sbt", "kotlin", "scala",
  // BEAM
  "elixir", "beam.smp", "beam", "iex", "erl",
  // PHP
  "php", "php-fpm",
  // .NET / Dart
  "dotnet", "dart"
])

/** macOS system daemons that squat on ports people also use for dev work —
 *  ControlCenter alone binds both 5000 and 7000 for AirPlay Receiver. They are
 *  matched by name rather than by port because the port is exactly the thing
 *  that makes them look interesting, and none of them is ever the user's app. */
const SYSTEM_COMMANDS: ReadonlyArray<string> = [
  "controlcenter",
  "airplayxpchelper",
  "rapportd",
  "sharingd",
  "remoted",
  "mdnsresponder",
  "identityservicesd",
  "launchd",
  "sshd",
  "cupsd",
  "spotlightnetheh"
]

/** Ports people actually put dev servers on. */
const DEV_PORT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [3000, 3099],
  [4000, 4399],
  [5000, 5099],
  [5173, 5199],
  [5400, 5499],
  [5555, 5555],
  [6006, 6006],
  // Deliberately no 7000-7099: macOS binds 7000 for AirPlay Receiver, and the
  // range is not where dev servers actually land, so including it reports a
  // system service to every user as though it were their code.
  [8000, 8099],
  [8888, 8888],
  [9000, 9229]
]

/** Is this listener worth putting in front of a person?
 *
 *  Three signals, strongest first.
 *
 *  A resolved `appName` is the strongest: it means the process is running from
 *  a directory with a project manifest in it, which is a statement about what
 *  the process IS rather than a pattern match on what it is called. It is also
 *  the only signal that catches a compiled binary — a Go or Rust service run as
 *  `./api` reports its own name, which no command list can anticipate, so
 *  before this arm existed those were found only if they happened to land on a
 *  dev port.
 *
 *  The command list catches interpreted runtimes started from anywhere. The
 *  port ranges are the last resort: a guess from a number, and the arm that
 *  most wants replacing, which is exactly why the other two come first. */
/** Reduce a command to something an exact match can be made against:
 *  `Python3.12` → `python`, `php8.2` → `php`, `/usr/bin/node` → `node`. lsof
 *  reports the executable's own name, and interpreters routinely carry their
 *  version in it, so a raw comparison would miss every one of them. */
export const normalise = (command: string): string => {
  const base = command.toLowerCase().split("/").pop() ?? ""
  // Strip a trailing version, but never a bare digit that is part of the name
  // (`python2` keeps nothing to strip once `2` goes, which is correct — the
  // family name is what we match on).
  return base.replace(/[\d.]+$/, "")
}

export const worthReporting = (row: ListeningPort): boolean => {
  const cmd = normalise(row.command)
  if (SYSTEM_COMMANDS.some((c) => cmd.startsWith(c))) return false
  if (row.appName !== undefined) return true
  if (DEV_COMMANDS.has(cmd) || DEV_COMMANDS.has(row.command.toLowerCase())) return true
  return DEV_PORT_RANGES.some(([lo, hi]) => row.port >= lo && row.port <= hi)
}

/** Is `child` at or below `parent`? Separator-guarded, so `/dev/api-v2` does
 *  not read as a child of `/dev/api`. */
export const isUnder = (child: string, parent: string): boolean => {
  const a = child.replace(/\/+$/, "")
  const b = parent.replace(/\/+$/, "")
  return a === b || a.startsWith(b + sep)
}

/** States in which the engine is the one running this project — discovery must
 *  not report a claim against something it started itself. */
const ENGINE_OWNS: ReadonlyArray<RuntimeState> = ["starting", "running", "stopping"]

export interface ClassifyInput {
  readonly projects: ReadonlyArray<Project>
  readonly states: ReadonlyMap<string, RuntimeState>
  readonly listeners: ReadonlyArray<ListeningPort>
  readonly containers: ReadonlyArray<DiscoveredContainer>
  readonly stacks: ReadonlyArray<DiscoveredStack>
  readonly dockerDaemonRunning: boolean
  /** Pids the engine spawned and still believes are alive. */
  readonly ourPids: ReadonlySet<number>
}

export interface ClassifyResult {
  readonly claims: ReadonlyArray<ForeignClaim>
  readonly unmanaged: ReadonlyArray<UnmanagedEntry>
}

const displayNameOf = (row: ListeningPort): string => row.appName ?? row.command

const stackMatchesFile = (stack: DiscoveredStack, file: string): boolean =>
  stack.configFiles.split(",").some((f) => f.trim() === file)

const isStackRunning = (stack: DiscoveredStack): boolean =>
  stack.status.toLowerCase().includes("running")

export const classify = (input: ClassifyInput): ClassifyResult => {
  const { projects, states, listeners, dockerDaemonRunning, ourPids } = input
  const containers = dockerDaemonRunning ? input.containers : []
  const stacks = dockerDaemonRunning ? input.stacks : []

  const claims: Array<ForeignClaim> = []
  // Everything accounted for by a project — claimed or engine-run — so the
  // unmanaged pass below never re-reports a project as a stranger.
  const accountedPids = new Set<number>(ourPids)
  const accountedPorts = new Set<number>()
  const accountedContainers = new Set<string>()

  for (const project of projects) {
    const engineRuns = ENGINE_OWNS.includes(states.get(project.id as string) ?? "idle")
    const declared = project.ports.map((p) => p.number)

    // A project the engine is running owns its ports by definition. Mark them
    // accounted and move on — probing them could only produce a false claim
    // against our own child.
    if (engineRuns) {
      for (const port of declared) accountedPorts.add(port)
      if (project.kind === "docker") accountedContainers.add(containerName(project.name))
      continue
    }

    if (project.kind === "process") {
      for (const port of declared) {
        const holder = listeners.find((l) => l.port === port && !ourPids.has(l.pid))
        if (holder === undefined) continue
        accountedPids.add(holder.pid)
        accountedPorts.add(port)

        const sameRoot = holder.cwd !== undefined && isUnder(holder.cwd, project.root)
        const evidence = sameRoot ? "root" : "port"
        claims.push({
          projectId: project.id,
          projectName: project.name,
          port,
          pid: holder.pid,
          holder: displayNameOf(holder),
          cwd: holder.cwd,
          evidence,
          message: sameRoot
            ? `${project.name} is already running on port ${port} (pid ${holder.pid}, ${holder.command}) from ${holder.cwd} — started outside matisa`
            : `port ${port} is held by ${holder.command} (pid ${holder.pid})${holder.cwd !== undefined ? ` running in ${holder.cwd}` : ""}, which is not ${project.name}'s directory — matisa cannot start ${project.name} until it is free`
        })
      }
      continue
    }

    if (project.kind === "docker") {
      const cname = containerName(project.name)
      const container = containers.find((c) => c.name === cname)
      if (container === undefined) continue
      accountedContainers.add(cname)
      if (container.state !== "running") continue
      for (const port of container.hostPorts) accountedPorts.add(port)
      claims.push({
        projectId: project.id,
        projectName: project.name,
        holder: cname,
        evidence: "container",
        message: `container ${cname} is running (${container.image}) but this engine did not start it — the daemon outlived a previous matisa, or it was started with docker directly`
      })
      continue
    }

    // compose: the stack is the unit, matched by config file path rather than
    // name — a compose file's own `name:` directive routinely differs from the
    // project name in matisa's catalog.
    const file = project.composeFile
    if (file === undefined) continue
    const stack = stacks.find((s) => stackMatchesFile(s, file))
    if (stack === undefined || !isStackRunning(stack)) continue
    for (const c of containers) {
      if (c.name.startsWith(`${stack.name}-`) || c.name.startsWith(`${stack.name}_`)) {
        accountedContainers.add(c.name)
        for (const port of c.hostPorts) accountedPorts.add(port)
      }
    }
    claims.push({
      projectId: project.id,
      projectName: project.name,
      holder: stack.name,
      evidence: "container",
      message: `compose stack ${stack.name} (${file}) is up but this engine did not bring it up`
    })
  }

  // ── unmanaged synthesis ───────────────────────────────────────────────────

  const unmanaged: Array<UnmanagedEntry> = []
  const seenPids = new Set<number>()

  for (const row of listeners) {
    if (accountedPids.has(row.pid) || accountedPorts.has(row.port)) continue
    if (row.pid <= 1 || seenPids.has(row.pid)) continue
    if (!worthReporting(row)) continue
    seenPids.add(row.pid)
    unmanaged.push({
      kind: "process",
      ref: `pid:${row.pid}`,
      displayName: displayNameOf(row),
      detail: row.cwd !== undefined ? `${row.command} · ${row.cwd}` : row.command,
      pid: row.pid,
      port: row.port,
      cwd: row.cwd,
      running: true
    })
  }

  // Known stacks are excluded wholesale: their containers are the stack's
  // business, and listing eight of them next to the one project they belong to
  // is noise, not information.
  const knownStackNames = new Set(
    projects.flatMap((p) =>
      p.kind === "compose" && p.composeFile !== undefined
        ? stacks.filter((s) => stackMatchesFile(s, p.composeFile as string)).map((s) => s.name)
        : []
    )
  )

  for (const c of containers) {
    if (accountedContainers.has(c.name)) continue
    // Ours by name. If it were also ours by catalog it would already be
    // accounted for above; reaching here means the catalog entry is gone, and
    // a leftover matisa container is still not a stranger's to list.
    if (c.name.startsWith(CONTAINER_PREFIX)) continue
    if ([...knownStackNames].some((n) => c.name.startsWith(`${n}-`) || c.name.startsWith(`${n}_`))) {
      continue
    }
    unmanaged.push({
      kind: "container",
      ref: `container:${c.name}`,
      displayName: c.name,
      detail: c.image,
      port: c.hostPorts[0],
      running: c.state === "running",
      cwd: undefined,
      pid: undefined
    })
  }

  return {
    claims,
    // Running things first, then by port: what is live and holding something is
    // what a person scanning this list is looking for.
    unmanaged: [...unmanaged].sort(
      (a, b) =>
        Number(b.running) - Number(a.running) ||
        (a.port ?? Number.MAX_SAFE_INTEGER) - (b.port ?? Number.MAX_SAFE_INTEGER) ||
        a.displayName.localeCompare(b.displayName)
    )
  }
}

/** The projects a snapshot says are up outside the engine. */
export const claimedProjectIds = (claims: ReadonlyArray<ForeignClaim>): ReadonlySet<ProjectId> =>
  new Set(claims.map((c) => c.projectId))
