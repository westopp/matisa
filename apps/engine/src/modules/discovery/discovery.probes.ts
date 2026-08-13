import { Effect } from "effect"
import { execFile } from "node:child_process"
import type { DiscoveredContainer, DiscoveredStack, ListeningPort } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// The raw probes. Everything here shells out, and everything here is
// best-effort: a missing binary, a stopped daemon, or a machine with nothing
// listening all mean "nothing to report", never a failure. Discovery describes
// the world as it is; it is never the reason an operation fails.
//
// The probes are deliberately batched. Asking lsof once for every listener and
// once for every cwd costs two process spawns regardless of how many pids are
// involved, where a per-pid loop would cost dozens — and this runs behind a
// user-visible refresh.
// ────────────────────────────────────────────────────────────────────────────

const LSOF = "lsof"
const DOCKER = "docker"
const PROBE_TIMEOUT_MS = 5_000

const run = (bin: string, args: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.async<string>((resume) => {
    const child = execFile(
      bin,
      [...args],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      // lsof exits non-zero when it simply found nothing, so stdout is read
      // regardless of the exit status: an error with output is still an answer.
      (_error, stdout) => resume(Effect.succeed(stdout ?? ""))
    )
    return Effect.sync(() => child.kill())
  })

// ── lsof field-mode parsing ─────────────────────────────────────────────────
//
// `-F` emits one field per line, tagged by its first character, in process →
// file order: `p<pid>` and `c<command>` open a process block, then `n<name>`
// per file within it. So the parser is a fold that carries the current process
// header down onto each file line it sees.

/** Split `*:5173`, `127.0.0.1:5173`, `[::1]:5173` into address and port. */
export const parseAddress = (raw: string): { address: string; port: number } | undefined => {
  const colon = raw.lastIndexOf(":")
  if (colon <= 0) return undefined
  const port = Number(raw.slice(colon + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { address: raw, port }
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` into one row per listening socket. */
export const parseListeners = (raw: string): ReadonlyArray<ListeningPort> => {
  const out: Array<ListeningPort> = []
  let pid: number | undefined
  let command: string | undefined

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue
    const body = line.slice(1)
    switch (line[0]) {
      case "p":
        pid = Number(body)
        // A new process block invalidates the previous command name; leaving it
        // set would mislabel the first socket of a process lsof named oddly.
        command = undefined
        break
      case "c":
        command = body
        break
      case "n": {
        if (pid === undefined || !Number.isInteger(pid)) break
        // `-sTCP:LISTEN` already filters, but lsof still prints the peer form
        // for some sockets; anything with an arrow is a connection, not a bind.
        if (body.includes("->")) break
        const parsed = parseAddress(body)
        if (parsed === undefined) break
        out.push({ pid, command: command ?? "?", address: parsed.address, port: parsed.port })
        break
      }
      default:
        break
    }
  }
  return out
}

/** Parse `lsof -a -p <csv> -d cwd -Fpn` into pid → working directory. */
export const parseCwds = (raw: string): ReadonlyMap<number, string> => {
  const out = new Map<number, string>()
  let pid: number | undefined
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue
    const body = line.slice(1)
    if (line[0] === "p") pid = Number(body)
    else if (line[0] === "n" && pid !== undefined && body.length > 0 && !out.has(pid)) {
      out.set(pid, body)
    }
  }
  return out
}

/** Every TCP listener on this machine that this user can see. */
export const listeningPorts = (): Effect.Effect<ReadonlyArray<ListeningPort>> =>
  run(LSOF, ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]).pipe(Effect.map(parseListeners))

/** Working directory per pid — the evidence behind every ownership claim.
 *  One lsof call for the whole set; pids it cannot read are simply absent. */
export const workingDirs = (
  pids: ReadonlyArray<number>
): Effect.Effect<ReadonlyMap<number, string>> =>
  pids.length === 0
    ? Effect.succeed(new Map<number, string>())
    : run(LSOF, ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"]).pipe(Effect.map(parseCwds))

// ── the engine's own process tree ────────────────────────────────────────────
//
// Spawn records name the process the supervisor started, and nothing below it.
// That was already thin — `npm run dev` binds its port from the `vite` child,
// so the child looked like a stranger holding the project's own port — and the
// manifest signal made it worse: the engine's Caddy runs from the matisa repo,
// so it started resolving a name and reporting itself.
//
// Descent from the engine pid answers the question properly. Anything the
// engine is an ancestor of is the engine's, whether the supervisor recorded it
// or a module spawned it directly.

export const parseProcessTree = (raw: string): ReadonlyMap<number, number> => {
  const parents = new Map<number, number>()
  for (const line of raw.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid as number, ppid as number)
  }
  return parents
}

/** Every pid descended from `root`, `root` included. */
export const descendantsOf = (
  parents: ReadonlyMap<number, number>,
  root: number
): ReadonlySet<number> => {
  const children = new Map<number, Array<number>>()
  for (const [pid, ppid] of parents) {
    const list = children.get(ppid)
    if (list === undefined) children.set(ppid, [pid])
    else list.push(pid)
  }
  const out = new Set<number>([root])
  const queue = [root]
  while (queue.length > 0) {
    for (const child of children.get(queue.pop() as number) ?? []) {
      if (out.has(child)) continue
      out.add(child)
      queue.push(child)
    }
  }
  return out
}

/** One `ps` for the whole table, then a walk. Cheaper and more complete than
 *  asking about each candidate pid in turn. */
export const processTree = (root: number): Effect.Effect<ReadonlySet<number>> =>
  run("ps", ["-Ao", "pid=,ppid="]).pipe(
    Effect.map((raw) => descendantsOf(parseProcessTree(raw), root))
  )

// ── docker ──────────────────────────────────────────────────────────────────

/** Pull host-side ports out of docker's port column:
 *  `0.0.0.0:5432->5432/tcp, :::5432->5432/tcp` → [5432]. Only mapped ports
 *  count — an `8080/tcp` with no arrow is exposed inside the network only. */
export const parseHostPorts = (raw: string): ReadonlyArray<number> => {
  const out = new Set<number>()
  for (const chunk of raw.split(",")) {
    const arrow = chunk.indexOf("->")
    if (arrow < 0) continue
    const left = chunk.slice(0, arrow).trim()
    const colon = left.lastIndexOf(":")
    if (colon < 0) continue
    const port = Number(left.slice(colon + 1))
    if (Number.isInteger(port) && port > 0) out.add(port)
  }
  return [...out].sort((a, b) => a - b)
}

const CONTAINER_FORMAT = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}"

export const parseContainers = (raw: string): ReadonlyArray<DiscoveredContainer> => {
  const out: Array<DiscoveredContainer> = []
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue
    const [id, name, image, state, status, ports] = line.split("\t")
    if (id === undefined || name === undefined) continue
    out.push({
      id,
      name,
      image: image ?? "",
      state: state ?? "",
      status: status ?? "",
      hostPorts: parseHostPorts(ports ?? "")
    })
  }
  return out
}

/** Every container, running or not — a stopped one is still something the user
 *  may want to start from here, which is why `ps -a` and not `ps`. */
export const containers = (): Effect.Effect<ReadonlyArray<DiscoveredContainer>> =>
  run(DOCKER, ["ps", "-a", "--format", CONTAINER_FORMAT]).pipe(Effect.map(parseContainers))

export const parseStacks = (raw: string): ReadonlyArray<DiscoveredStack> => {
  const text = raw.trim()
  if (text.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): ReadonlyArray<DiscoveredStack> => {
      if (typeof entry !== "object" || entry === null) return []
      const row = entry as Record<string, unknown>
      const name = typeof row["Name"] === "string" ? row["Name"] : undefined
      if (name === undefined) return []
      return [
        {
          name,
          status: typeof row["Status"] === "string" ? row["Status"] : "",
          configFiles: typeof row["ConfigFiles"] === "string" ? row["ConfigFiles"] : ""
        }
      ]
    })
  } catch {
    return []
  }
}

export const composeStacks = (): Effect.Effect<ReadonlyArray<DiscoveredStack>> =>
  run(DOCKER, ["compose", "ls", "-a", "--format", "json"]).pipe(Effect.map(parseStacks))
