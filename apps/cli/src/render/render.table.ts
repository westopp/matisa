import type {
  Accepted,
  EnvContext,
  ExposureEntry,
  ExposureSnapshot,
  Project,
  ProjectWithState,
  RuntimeStatus
} from "@matisa/core"

// Human-readable table/line emitters. Pure string builders — the Renderer
// service decides when to use them vs the JSON emitter.

const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length)

const portsOf = (p: Project): string =>
  p.ports.length === 0
    ? "-"
    : p.ports.map((port) => `${port.number}/${port.protocol}`).join(",")

const cmdOf = (p: Project): string => {
  switch (p.kind) {
    case "docker":
      return `docker:${p.image ?? "?"}`
    case "compose":
      return `compose:${p.composeFile ?? "?"}`
    case "process":
      return p.command === undefined ? "-" : [p.command.program, ...p.command.args].join(" ")
  }
}

export const projectsTable = (rows: ReadonlyArray<ProjectWithState>): string => {
  if (rows.length === 0) return "no projects"
  const header = [
    pad("ID", 14),
    pad("NAME", 18),
    pad("STATE", 10),
    pad("PID", 7),
    pad("PORTS", 12),
    "COMMAND"
  ].join("  ")
  const lines = rows.map((r) =>
    [
      pad(r.id, 14),
      pad(r.name, 18),
      pad(r.state, 10),
      pad(r.pid === undefined ? "-" : String(r.pid), 7),
      pad(portsOf(r), 12),
      cmdOf(r)
    ].join("  ")
  )
  return [header, ...lines].join("\n")
}

export const projectLine = (p: Project): string =>
  `${p.id}  ${p.name}  ${p.kind}  ${p.root}  [${portsOf(p)}]  ${cmdOf(p)}${
    p.groupSlug === undefined ? "" : `  group=${p.groupSlug}`
  }`

export const projectStateLine = (p: ProjectWithState): string =>
  `${p.id}  ${p.name}  ${p.state}${p.pid === undefined ? "" : `  pid=${p.pid}`}${
    p.health === undefined ? "" : `  health=${p.health}`
  }`

export const statusLine = (s: RuntimeStatus): string =>
  `${s.id}  ${s.state}${s.pid === undefined ? "" : `  pid=${s.pid}`}${
    s.since === undefined ? "" : `  since=${new Date(s.since).toISOString()}`
  }${s.health === undefined ? "" : `  health=${s.health}`}${
    s.sessionId === undefined ? "" : `  session=${s.sessionId}`
  }`

export const acceptedLine = (a: Accepted): string =>
  `accepted  ${a.id}  -> ${a.state}`

export const removedLine = (id: string): string => `removed  ${id}`

/** Values are printed as given. Masking a secret is the CALLER's job (see the
 *  header of commands.env.ts): doing it here too would mean `env reveal` — the
 *  one command whose entire purpose is to show the value — could not, while
 *  `--json` still would. One layer decides, and it is the layer that knows
 *  which command the user asked for. */
const varsOf = (c: EnvContext): string =>
  c.vars.length === 0 ? "(empty)" : c.vars.map((v) => `${v.key}=${v.value}`).join(" ")

export const envTable = (list: ReadonlyArray<EnvContext>): string => {
  if (list.length === 0) return "no env contexts"
  return list
    .map((c) => `${pad(c.id, 14)}  ${pad(c.name, 16)}  ${varsOf(c)}`)
    .join("\n")
}

export const envContextLine = (c: EnvContext): string =>
  `${c.id}  ${c.name}  ${varsOf(c)}`

// ── exposure ────────────────────────────────────────────────────────────────

const entryLine = (e: ExposureEntry): string => {
  // `active` reads clean; anything else carries the engine's message so the
  // user sees WHY a URL isn't live (caddy down, no LAN, port never bound).
  const suffix =
    e.state === "active"
      ? ""
      : `  (${e.state}${e.message === undefined ? "" : `: ${e.message}`})`
  return `  ${pad(e.kind, 11)}  ${e.url}${suffix}`
}

export const exposureTable = (snap: ExposureSnapshot): string => {
  const caddy = snap.caddy.available
    ? `caddy running=${snap.caddy.running} http=:${snap.caddy.httpPort}${
        snap.caddy.lanIp === undefined ? "" : ` lan=${snap.caddy.lanIp}`
      }`
    : "caddy not installed — brew install caddy"
  if (snap.projects.length === 0) return `${caddy}\nno exposed projects`
  const blocks = snap.projects.map(
    (p) => `${p.projectId}\n${p.entries.map(entryLine).join("\n")}`
  )
  return [caddy, "", ...blocks].join("\n")
}

/** One project's entries — for `exposure share`/`unshare` results. */
export const exposureEntriesLines = (
  id: string,
  entries: ReadonlyArray<ExposureEntry>
): string =>
  entries.length === 0
    ? `${id}\n  (no exposure — declare a port first)`
    : `${id}\n${entries.map(entryLine).join("\n")}`
