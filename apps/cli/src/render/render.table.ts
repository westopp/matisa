import type {
  Accepted,
  EnvContext,
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

const cmdOf = (p: Project): string =>
  [p.command.program, ...p.command.args].join(" ")

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
  `${p.id}  ${p.name}  ${p.root}  [${portsOf(p)}]  ${cmdOf(p)}`

export const projectStateLine = (p: ProjectWithState): string =>
  `${p.id}  ${p.name}  ${p.state}${p.pid === undefined ? "" : `  pid=${p.pid}`}`

export const statusLine = (s: RuntimeStatus): string =>
  `${s.id}  ${s.state}${s.pid === undefined ? "" : `  pid=${s.pid}`}${
    s.since === undefined ? "" : `  since=${new Date(s.since).toISOString()}`
  }${s.sessionId === undefined ? "" : `  session=${s.sessionId}`}`

export const acceptedLine = (a: Accepted): string =>
  `accepted  ${a.id}  -> ${a.state}`

export const removedLine = (id: string): string => `removed  ${id}`

const varsOf = (c: EnvContext): string =>
  c.vars.length === 0
    ? "(empty)"
    : c.vars
        .map((v) => (v.kind === "plain" ? `${v.key}=${v.value}` : `${v.key}=<secret>`))
        .join(" ")

export const envTable = (list: ReadonlyArray<EnvContext>): string => {
  if (list.length === 0) return "no env contexts"
  return list
    .map((c) => `${pad(c.id, 14)}  ${pad(c.name, 16)}  ${varsOf(c)}`)
    .join("\n")
}

export const envContextLine = (c: EnvContext): string =>
  `${c.id}  ${c.name}  ${varsOf(c)}`
