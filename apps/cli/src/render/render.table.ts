import type {
  Accepted,
  DiscoveryActionResult,
  DiscoverySnapshot,
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
  // `unmanaged` is the one state whose name does not carry its own instruction.
  // It reads like a variant of idle, and acting on that reading — starting the
  // project — fails on the port. Say what it means once, under the table, only
  // when there is one.
  const unmanaged = rows.filter((r) => r.state === "unmanaged")
  if (unmanaged.length === 0) return [header, ...lines].join("\n")
  return [
    header,
    ...lines,
    "",
    `note: ${unmanaged.map((r) => r.name).join(", ")} ${unmanaged.length === 1 ? "is" : "are"} running outside matisa. ` +
      `Run \`matisa discovery list\` to see what holds ${unmanaged.length === 1 ? "it" : "them"}, ` +
      "`matisa takeover <id>` to reclaim."
  ].join("\n")
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

// ── discovery ───────────────────────────────────────────────────────────────
//
// Claims lead, unmanaged rows follow. That order is the point of the whole
// command: a claim is something the reader has to decide about (their project
// is up and matisa is not running it), while the unmanaged list is inventory.
// Each claim states the evidence in words rather than printing the enum,
// because "started outside matisa" and "a stranger is on your port" call for
// completely different next steps and the difference must not need decoding.

const claimBlock = (c: DiscoverySnapshot["claims"][number]): string => {
  const verdict =
    c.evidence === "root"
      ? "your app, started outside matisa — `matisa takeover` will reclaim it"
      : c.evidence === "container"
        ? "started by docker directly — `matisa takeover` will replace it"
        : "NOT recognised as this project — check it before `matisa takeover --force`"
  const where = [
    c.port === undefined ? undefined : `port ${c.port}`,
    c.pid === undefined ? undefined : `pid ${c.pid}`,
    c.cwd
  ]
    .filter((s): s is string => s !== undefined)
    .join("  ")
  // A container claim has no port, pid or cwd of its own — the container name
  // IS the locator — so the line is dropped rather than printed empty.
  return [
    `! ${pad(c.projectName, 18)} held by ${c.holder}`,
    ...(where.length === 0 ? [] : [`    ${where}`]),
    `    ${verdict}`,
    `    ${c.message}`
  ].join("\n")
}

export const discoveryTable = (snap: DiscoverySnapshot): string => {
  const head = `swept ${new Date(snap.takenAt).toISOString()}  docker=${
    snap.dockerDaemonRunning ? "running" : "down"
  }`

  const claims =
    snap.claims.length === 0
      ? ["no configured project is running outside matisa"]
      : [
          `${snap.claims.length} project${snap.claims.length === 1 ? "" : "s"} running outside matisa:`,
          ...snap.claims.map(claimBlock)
        ]

  // Columns are sized to their contents, unlike the fixed-width tables
  // elsewhere here. A container ref is `container:<name>` and docker names run
  // long; a fixed pad would let one row shove every column after it out of
  // line, and a misaligned table is worse than a wide one — `ref` is the value
  // the next command takes, so it has to be copyable at a glance.
  const cells = snap.unmanaged.map((u) => [
    u.ref,
    u.displayName,
    u.port === undefined ? "-" : String(u.port),
    u.running ? "running" : "stopped",
    u.detail
  ])
  const headings = ["REF", "NAME", "PORT", "STATE", "DETAIL"]
  const widths = headings.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => (row[i] ?? "").length))
  )
  // The last column is never padded — trailing whitespace on every line is
  // invisible until someone copies it.
  const line = (row: ReadonlyArray<string>): string =>
    row.map((c, i) => (i === row.length - 1 ? c : pad(c, widths[i] ?? 0))).join("  ")

  const rows =
    snap.unmanaged.length === 0
      ? ["nothing unmanaged worth reporting"]
      : [`${snap.unmanaged.length} unmanaged:`, line(headings), ...cells.map(line)]

  return [head, "", ...claims, "", ...rows].join("\n")
}

export const discoveryActionLine = (r: DiscoveryActionResult): string =>
  `${r.ref}  ${r.running ? "running" : "stopped"}  ${r.message}`

/** One project's entries — for `exposure share`/`unshare` results. */
export const exposureEntriesLines = (
  id: string,
  entries: ReadonlyArray<ExposureEntry>
): string =>
  entries.length === 0
    ? `${id}\n  (no exposure — declare a port first)`
    : `${id}\n${entries.map(entryLine).join("\n")}`
