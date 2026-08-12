import { useCallback, useEffect, useMemo, useState } from "react"
import type { CrashRecord, ProjectId, ProjectWithState } from "@matisa/core"
import { clearSession } from "~/rpc/rpc.pty"
import { useEngine, type ActivityEntry } from "~/store/store.engine"
import { isSystemId, SYSTEM_IDS, systemName } from "~/store/store.systems"
import { useUi, type DrawerTab } from "~/store/store.ui"
import { Dialog } from "./forms/dialog"
import { ConfirmDialog } from "./forms/confirm"
import { Icons } from "./icons"
import { formatMB } from "./primitives"

// ────────────────────────────────────────────────────────────────────────────
// The inspector: engine-reported history, overlaid on the content rather than
// docked beside it. Everything in here is read, acted on, and dismissed —
// paying for it in permanent horizontal space would tax the terminals, which
// are what the width belongs to.
//
// It is global by default and narrowable to the selected project, because the
// questions it answers ("what just died", "what is eating the CPU") are asked
// about the network as often as about the project in the URL.
// ────────────────────────────────────────────────────────────────────────────

const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })

const stamp = (ts: number): string => new Date(ts).toLocaleString()

/** Strip ANSI escapes. The tail comes off a real TTY, so it is full of colour
 *  codes that xterm renders and a `<pre>` shows as `[33m` litter. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;?]*[ -/]*[@-~]/g
const plain = (text: string): string => text.replace(ANSI, "")

/** Names are looked up per row; a Map keeps that O(1) rather than a linear scan
 *  per entry across a 300-row activity table. Systems answer first — they are
 *  not in the catalog, and a row about the engine reading "unknown" is exactly
 *  the dead end that made them uninspectable. */
const useProjectNames = (): ((id: ProjectId) => string) => {
  const projects = useEngine((s) => s.projects)
  const byId = useMemo(() => new Map(projects.map((p) => [p.id as string, p.name])), [projects])
  return (id) => systemName(id) ?? byId.get(id) ?? "unknown"
}

/** The clear control every history tab carries, in the same slot with the same
 *  glyph. Resources has none on purpose: it is a live sample, not a history —
 *  there is nothing to forget, and the next poll would put it straight back. */
const ClearBar = ({
  count,
  noun,
  scopeLabel,
  confirmTitle,
  children,
  onClear
}: {
  count: number
  noun: [string, string]
  scopeLabel: string | null
  confirmTitle: string
  /** What the confirm dialog says goes. */
  children: React.ReactNode
  onClear: () => void
}) => {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <div className="detail-bar failures-bar">
        <span className="detail-label">
          {count} {count === 1 ? noun[0] : noun[1]}
          {scopeLabel === null ? "" : ` · ${scopeLabel}`}
        </span>
        <button className="ico danger-hover" title={confirmTitle} onClick={() => setConfirming(true)}>
          <Icons.Eraser size={13} />
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={confirmTitle}
          confirmLabel="Clear"
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            onClear()
          }}
        >
          {children}
        </ConfirmDialog>
      )}
    </>
  )
}

const Empty = ({ children }: { children: string }) => <div className="card-empty">{children}</div>

// ── tabs ────────────────────────────────────────────────────────────────────

/** Copy that says it worked. A button that does nothing visible is a button you
 *  press twice. */
const CopyButton = ({ text, label = false }: { text: string; label?: boolean }) => {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return label ? (
    <button className="btn sm" onClick={copy} title="Copy output">
      {copied ? <Icons.Check size={12} /> : <Icons.Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  ) : (
    <button className="ico" onClick={copy} title={copied ? "Copied" : "Copy output"}>
      {copied ? <Icons.Check size={13} /> : <Icons.Copy size={13} />}
    </button>
  )
}

/** One failure: the summary row, plus — once opened — a second row whose single
 *  cell spans every column. Output is wide by nature; boxing it into the "why"
 *  column would leave a 200px gutter of wrapped stack trace. */
const FailureRow = ({
  failure,
  columns,
  project,
  onExpand
}: {
  failure: CrashRecord
  columns: number
  project: string | null
  onExpand: () => void
}) => {
  const [open, setOpen] = useState(false)
  const tail = failure.logTail

  return (
    <>
      <tr className={open ? "row-open" : ""}>
        <td className="details-cell">
          {tail !== undefined && (
            <button
              className={`details-btn ${open ? "open" : ""}`}
              title={open ? "Hide output" : "Show output"}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <Icons.ChevronRight size={12} />
            </button>
          )}
        </td>
        <td className="mono" title={stamp(failure.ts)}>
          {clock(failure.ts)}
        </td>
        {project !== null && (
          <td className="trunc" title={project}>
            {project}
          </td>
        )}
        {/* An engine error has no exit code to show — it never got as far as a
            process — so the column says which kind of failure this was instead
            of showing an em dash and leaving the reader to guess. */}
        <td className="mono">
          {failure.kind === "error" ? (
            <span className="failure-kind">error</span>
          ) : (
            (failure.signal ?? failure.exitCode ?? "—")
          )}
        </td>
        <td>{failure.summary ?? (failure.kind === "error" ? "could not start" : "exited unexpectedly")}</td>
      </tr>
      {open && tail !== undefined && (
        <tr className="failure-details">
          <td colSpan={columns}>
            <div className="detail-bar">
              <span className="detail-label">output</span>
              <CopyButton text={tail} />
              <button className="ico" title="Expand" onClick={onExpand}>
                <Icons.Maximize size={13} />
              </button>
            </div>
            <pre className="log-tail">{tail}</pre>
          </td>
        </tr>
      )}
    </>
  )
}

const FailuresTab = ({ scopeId, nameOf }: { scopeId: ProjectId | null; nameOf: (id: ProjectId) => string }) => {
  const all = useEngine((s) => s.failures)
  const clearFailures = useEngine((s) => s.clearFailures)
  const failures = scopeId === null ? all : all.filter((f) => f.projectId === scopeId)
  const [expanded, setExpanded] = useState<CrashRecord | null>(null)

  if (failures.length === 0) return <Empty>No crashes or errors.</Empty>

  const columns = scopeId === null ? 5 : 4

  return (
    <>
      {/* The history is kept FOR the user; once read it is theirs to discard.
          Scoped to whatever the tab is showing, so "clear" never quietly takes
          more than what is on screen. */}
      <ClearBar
        count={failures.length}
        noun={["failure", "failures"]}
        scopeLabel={scopeId === null ? null : nameOf(scopeId)}
        confirmTitle={scopeId === null ? "Clear every failure?" : `Clear ${nameOf(scopeId)}'s failures?`}
        onClear={() => void clearFailures(scopeId ?? undefined)}
      >
        {failures.length} recorded {failures.length === 1 ? "failure goes" : "failures go"} for good — the engine
        forgets them too. Nothing running is touched, and nothing that fails from here on is affected.
      </ClearBar>

      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 26 }} />
            <th style={{ width: 86 }}>When</th>
            {scopeId === null && <th style={{ width: "26%" }}>Project</th>}
            <th style={{ width: 54 }}>Exit</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {failures.map((f) => (
            <FailureRow
              key={`${f.projectId}-${f.ts}-${f.kind}-${f.exitCode ?? f.signal ?? ""}`}
              failure={f}
              columns={columns}
              project={scopeId === null ? nameOf(f.projectId) : null}
              onExpand={() => setExpanded(f)}
            />
          ))}
        </tbody>
      </table>

      {expanded !== null && expanded.logTail !== undefined && (
        <Dialog
          title={`${nameOf(expanded.projectId)} — ${stamp(expanded.ts)}`}
          onClose={() => setExpanded(null)}
          footer={<CopyButton text={expanded.logTail} label />}
        >
          <div className="failure-summary">{expanded.summary ?? "exited unexpectedly"}</div>
          <pre className="log-full">{expanded.logTail}</pre>
        </Dialog>
      )}
    </>
  )
}

/** One colour per event class, so a wall of transitions can be skimmed for the
 *  two lines that matter. */
const activityClass = (kind: ActivityEntry["kind"]): string =>
  kind === "crash" ? "danger" : kind === "health" ? "warn" : kind === "state" ? "accent" : ""

const ActivityTab = ({ scopeId, nameOf }: { scopeId: ProjectId | null; nameOf: (id: ProjectId) => string }) => {
  const all = useEngine((s) => s.activity)
  const clearActivity = useEngine((s) => s.clearActivity)
  const entries = scopeId === null ? all : all.filter((e) => e.projectId === scopeId)

  if (entries.length === 0) return <Empty>No engine activity yet.</Empty>

  return (
    <>
      <ClearBar
        count={entries.length}
        noun={["entry", "entries"]}
        scopeLabel={scopeId === null ? null : nameOf(scopeId)}
        confirmTitle={scopeId === null ? "Clear the activity log?" : `Clear ${nameOf(scopeId)}'s activity?`}
        onClear={() => clearActivity(scopeId ?? undefined)}
      >
        This clears what THIS window kept. The engine's own event log is untouched, so a reconnect refills the
        tab from wherever its cursor is.
      </ClearBar>

      <table className="tbl">
      <thead>
        <tr>
          <th style={{ width: 86 }}>When</th>
          {scopeId === null && <th style={{ width: "26%" }}>Project</th>}
          <th>Event</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.seq}>
            <td className="mono" title={stamp(e.ts)}>
              {clock(e.ts)}
            </td>
            {scopeId === null && (
              <td className="trunc" title={nameOf(e.projectId)}>
                {nameOf(e.projectId)}
              </td>
            )}
            <td>
              <span className={`activity-label ${activityClass(e.kind)}`}>{e.label}</span>
              {e.detail !== undefined && (
                <div className="activity-detail" title={e.detail}>
                  {e.detail}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  )
}

const ResourcesTab =({ scopeId, nameOf }: { scopeId: ProjectId | null; nameOf: (id: ProjectId) => string }) => {
  const resources = useEngine((s) => s.resources)

  // Hottest first — the reason this table is opened is to find the one process
  // that is not idle. Sorted in render, not in the store: the poll rewrites the
  // whole map every few seconds anyway.
  const rows = Object.values(resources)
    .filter((r) => scopeId === null || r.projectId === scopeId)
    .sort((a, b) => b.cpuPercent - a.cpuPercent)

  if (rows.length === 0) return <Empty>Nothing is running.</Empty>

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Project</th>
          <th style={{ width: 64 }}>CPU</th>
          <th style={{ width: 74 }}>Memory</th>
          <th style={{ width: 64 }}>PID</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.projectId}>
            <td className="trunc" title={nameOf(r.projectId)}>
              {nameOf(r.projectId)}
            </td>
            <td className="mono">{r.cpuPercent.toFixed(1)}%</td>
            <td className="mono">{formatMB(r.rssBytes)} MB</td>
            <td className="mono">{r.pid ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The historical tail, read from the source on demand: docker's own log store
 *  for containers and stacks, the run session's scrollback for processes.
 *
 *  Deliberately NOT the live `log_line` ring buffer the log pane renders — that
 *  only ever holds what arrived while this client was watching, so everything a
 *  container said before you opened the app is invisible there. This is the
 *  answer to "what did it print overnight". */
const LogsTab = ({ project, systemId }: { project: ProjectWithState | null; systemId: ProjectId | null }) => {
  const tailLogs = useEngine((s) => s.tailLogs)
  const ensureRunSession = useEngine((s) => s.ensureRunSession)
  const session = useEngine((s) => (project === null ? undefined : s.runSessions[project.id]))
  const [lines, setLines] = useState<ReadonlyArray<string> | null>(null)
  const [loading, setLoading] = useState(false)
  const [count, setCount] = useState(200)
  const [clearing, setClearing] = useState(false)

  const projectId = project?.id ?? null

  const load = useCallback(
    async (n: number): Promise<void> => {
      if (projectId === null) return
      setLoading(true)
      try {
        setLines((await tailLogs(projectId, n)).map(plain))
      } finally {
        setLoading(false)
      }
    },
    [projectId, tailLogs]
  )

  // Re-read on project switch. A tail is a snapshot, so it is fetched rather
  // than subscribed — the live stream is the terminal's job, not this tab's.
  useEffect(() => {
    setLines(null)
    if (projectId !== null) void load(count)
  }, [projectId, count, load])

  // A system has no log tail to fetch: the engine writes to the terminal that
  // started it, and the Docker daemon to the OS log. Say which, rather than
  // showing the same "select a project" prompt at something that IS selected.
  if (systemId !== null) {
    return (
      <Empty>
        {systemId === SYSTEM_IDS.engine
          ? "The engine logs to the terminal it was started from."
          : "Docker logs to the system log, not through the engine."}
      </Empty>
    )
  }

  if (project === null) {
    return <Empty>Select a project to read its log tail.</Empty>
  }

  // The tail comes from the source, so clearing it has to reach the source. A
  // process's is its run session's scrollback, which `pty.clear` empties. A
  // container's belongs to docker, which has no clear short of recreating it —
  // so the control says why instead of pretending.
  //
  // The session id is resolved at CLICK time, not read from the store: it is
  // cached there only once the project's terminal pane has mounted, and this
  // tab is most often opened from the board, where it has not.
  const clearable = project.kind === "process"

  const clear = async (): Promise<void> => {
    setClearing(true)
    try {
      const sessionId = session?.sessionId ?? (await ensureRunSession(project.id))
      // No session means nothing was ever recorded — the view is already the
      // whole truth, so emptying it is the honest result rather than a no-op.
      if (sessionId !== null && sessionId !== undefined) await clearSession(sessionId)
      setLines([])
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="logs-tab">
      <div className="detail-bar">
        <span className="detail-label">
          {project.name} · last {count}
        </span>
        {lines !== null && lines.length > 0 && <CopyButton text={lines.join("\n")} />}
        <button className="ico" title="More lines" onClick={() => setCount((n) => Math.min(2_000, n * 2))}>
          <Icons.Plus size={13} />
        </button>
        <button className="ico" title="Refresh" disabled={loading} onClick={() => void load(count)}>
          <Icons.Refresh size={13} />
        </button>
        <button
          className="ico danger-hover"
          title={
            clearable
              ? "Clear the recorded output — the engine forgets it too"
              : "Docker owns this history; the engine cannot clear it"
          }
          disabled={!clearable || clearing}
          onClick={() => void clear()}
        >
          <Icons.Eraser size={13} />
        </button>
      </div>
      {loading && lines === null ? (
        <Empty>Reading…</Empty>
      ) : lines === null || lines.length === 0 ? (
        <Empty>No output recorded.</Empty>
      ) : (
        <pre className="log-full drawer-log">{lines.join("\n")}</pre>
      )}
    </div>
  )
}

// ── shell ───────────────────────────────────────────────────────────────────

const TAB_ICON: Record<DrawerTab, typeof Icons.XCircle> = {
  failures: Icons.XCircle,
  activity: Icons.Activity,
  resources: Icons.Cpu,
  logs: Icons.Logs
}

const TAB_LABEL: Record<DrawerTab, string> = {
  failures: "Failures",
  activity: "Activity",
  resources: "Resources",
  logs: "Logs"
}

export const RightDrawer = ({ selectedId }: { selectedId: ProjectId | null }) => {
  const open = useUi((s) => s.drawerOpen)
  const tab = useUi((s) => s.drawerTab)
  const scoped = useUi((s) => s.drawerScoped)
  const setTab = useUi((s) => s.setDrawerTab)
  const setScoped = useUi((s) => s.setDrawerScoped)
  const close = useUi((s) => s.closeDrawer)

  const failureCount = useEngine((s) => s.failures.length)
  const activityCount = useEngine((s) => s.activity.length)
  const selected = useEngine((s) => s.projects.find((p) => p.id === selectedId) ?? null)
  const nameOf = useProjectNames()

  // Escape closes it — an overlay that can only be dismissed by finding its
  // button again is an overlay you stop opening. A dialog on top owns the key
  // while it is up, though: one press must not dismiss both layers.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && document.querySelector(".scrim") === null) close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, close])

  // Scoping is only meaningful with something in the URL; on the index route the
  // drawer is unconditionally global.
  const scopeId = scoped && selectedId !== null ? selectedId : null
  const systemId = selectedId !== null && isSystemId(selectedId) ? selectedId : null

  return (
    <aside className={`drawer ${open ? "open" : ""}`} aria-hidden={!open}>
      <header className="drawer-head">
        <div className="tabs">
          {(Object.keys(TAB_LABEL) as ReadonlyArray<DrawerTab>).map((t) => {
            const TabIcon = TAB_ICON[t]
            const count = t === "failures" ? failureCount : t === "activity" ? activityCount : 0
            return (
              <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                <TabIcon size={12} />
                {TAB_LABEL[t]}
                {count > 0 && <span className="tab-count">{count}</span>}
              </button>
            )
          })}
        </div>
        <button className="ico-btn" title="Close (Esc)" onClick={close}>
          <Icons.X size={14} />
        </button>
      </header>

      {/* Logs are always about ONE project — there is no meaningful "all
          projects" tail — so the scope switch stands down on that tab. */}
      {selectedId !== null && tab !== "logs" && (
        <div className="drawer-scope">
          <button className={`scope-btn ${scoped ? "active" : ""}`} onClick={() => setScoped(true)}>
            {systemId === null ? "This project" : nameOf(systemId)}
          </button>
          <button className={`scope-btn ${scoped ? "" : "active"}`} onClick={() => setScoped(false)}>
            Everything
          </button>
        </div>
      )}

      <div className="drawer-body">
        {tab === "failures" && <FailuresTab scopeId={scopeId} nameOf={nameOf} />}
        {tab === "activity" && <ActivityTab scopeId={scopeId} nameOf={nameOf} />}
        {tab === "resources" && <ResourcesTab scopeId={scopeId} nameOf={nameOf} />}
        {tab === "logs" && <LogsTab project={selected} systemId={systemId} />}
      </div>
    </aside>
  )
}
