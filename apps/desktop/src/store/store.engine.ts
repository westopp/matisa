import { create } from "zustand"
import { Schema } from "effect"
import { toast } from "sonner"
import {
  EngineEvent,
  type CommandRunParams,
  type CommandSetParams,
  type ContextId,
  type CrashRecord,
  type DaemonStatusResult,
  type DiscoverySnapshot,
  type EngineStatus,
  type EnvContext,
  type EnvSetParams,
  type ExposureEntry,
  type ExposureSnapshot,
  type Group,
  type GroupSetParams,
  type GroupSlug,
  type Health,
  type NamedCommand,
  type NewProject,
  type ProjectId,
  type ProjectPatch,
  type ProjectWithState,
  type PtySession,
  type ResourceSample,
  type RuntimeState,
  type SessionId
} from "@matisa/core"
import { engineUrl, rpc, RpcError } from "~/rpc/rpc.client"
import { useLogs } from "~/store/store.logs"
import { isSystemId, SYSTEM_IDS } from "~/store/store.systems"

// ────────────────────────────────────────────────────────────────────────────
// The engine store: the client's whole view of the network (CARCH-201).
//
// Components never call `rpc` — they read state and invoke the actions below,
// so a component stays a function of its props and store slice. The engine is
// authoritative (thin-clients tenet); nothing here computes state, it mirrors
// what the engine reports and folds the live event stream on top.
//
// Two kinds of refresh:
//   • events   — state_changed / health_changed / crashed / catalog_changed
//                patch the mirror in place (cheap, immediate)
//   • snapshot — catalog.list + friends, on connect and on catalog_changed
//                (authoritative resync; the event log is prunable)
// ────────────────────────────────────────────────────────────────────────────

const decodeEvent = Schema.decodeUnknownOption(EngineEvent)

export interface RunSession {
  readonly sessionId: SessionId
  readonly since?: number
}

// ── activity: the event stream, kept ──────────────────────────────────────────
//
// Every non-log event already patches the mirror and then evaporates; a toast
// lasts seconds. The drawer's Activity tab is the history — "what did this
// project do while I was in another file" — so the same events are also folded
// into a ring buffer here. `log_line` is deliberately excluded: it is the one
// high-frequency event, it has its own store, and a chatty container would
// otherwise evict every transition worth reading.

export type ActivityKind = "state" | "health" | "crash" | "exposure" | "catalog"

export interface ActivityEntry {
  /** The engine's cursor — monotonic and gap-free, so it doubles as the key. */
  readonly seq: number
  readonly ts: number
  readonly projectId: ProjectId
  readonly kind: ActivityKind
  readonly label: string
  readonly detail?: string
}

/** Bounded like the log buffer: a fixed memory cost regardless of uptime. */
const MAX_ACTIVITY = 300

/** How many failures the client keeps in memory. The engine holds the durable
 *  history; this is the window the drawer reads. */
const MAX_FAILURES = 50

/** How far back to reach on connect so the tab is not empty on first open. The
 *  window is in SEQ, and log lines share that space — hence a window much wider
 *  than the number of entries it will actually yield. */
const ACTIVITY_BACKFILL = 400

/** Seq numbers for entries this client mints itself — a Docker daemon that
 *  refused to start, a socket that dropped. The engine's own seqs count up from
 *  zero, so these count DOWN from zero: unique, ordered among themselves, and
 *  incapable of colliding with a real cursor. */
let localSeq = 0
const nextLocalSeq = (): number => --localSeq

const describeEvent = (event: EngineEvent): ActivityEntry | null => {
  const base = { seq: event.seq, ts: event.ts, projectId: event.projectId }
  switch (event.type) {
    case "state_changed":
      return {
        ...base,
        kind: "state",
        label: `${event.payload.from} → ${event.payload.to}`,
        ...(event.payload.reason !== undefined ? { detail: event.payload.reason } : {})
      }
    case "health_changed":
      return {
        ...base,
        kind: "health",
        label: `health ${event.payload.health}`,
        ...(event.payload.message !== undefined ? { detail: event.payload.message } : {})
      }
    case "crashed":
      return {
        ...base,
        kind: "crash",
        label: `crashed (${event.payload.signal ?? event.payload.exitCode ?? "?"})`,
        ...(event.payload.summary !== undefined ? { detail: event.payload.summary } : {})
      }
    case "exposure_changed": {
      // The event carries the project's WHOLE entry set, not a delta, so the
      // line states the resulting shape rather than inventing a transition:
      // an empty set is the only unambiguous "down".
      const live = event.payload.entries.filter((e) => e.state === "active")
      return {
        ...base,
        kind: "exposure",
        label: live.length === 0 ? "exposure down" : `exposure ${live.length} live`,
        ...(live.length === 0 ? {} : { detail: live.map((e) => e.url).join(", ") })
      }
    }
    case "catalog_changed":
      return { ...base, kind: "catalog", label: `catalog ${event.payload.action}` }
    case "log_line":
      return null
  }
}

/** Engine errors carry a stable code and a message written for a human. Show it
 *  verbatim — paraphrasing loses the detail that makes it actionable. */
const describe = (cause: unknown): { title: string; detail?: string } => {
  if (cause instanceof RpcError) {
    const data = cause.data as { _tag?: string; code?: string } | undefined
    return { title: cause.message, detail: data?.code ?? data?._tag }
  }
  if (cause instanceof Error) return { title: cause.message }
  return { title: String(cause) }
}

/** Failures are never swallowed: if a project will not start, or is not ours to
 *  manage, the user is told (parity with the old app). */
export const reportError = (cause: unknown, context?: string): void => {
  const { title, detail } = describe(cause)
  toast.error(context === undefined ? title : `${context}: ${title}`, { description: detail })
}

const codeOf = (cause: unknown): string | undefined =>
  cause instanceof RpcError ? (cause.data as { code?: string } | undefined)?.code : undefined

// ── event-driven catalog resync, coalesced ──────────────────────────────────
//
// Every state_changed asks for a catalog resync (pid/session are not on the
// event), and a mass restart emits hundreds of them in seconds — each one a
// full fetch and a full sidebar re-render if taken literally. Trailing
// throttle: the first event in a window schedules ONE fetch, everything else
// in the window rides along. Not a debounce — a debounce resets its timer per
// event, so a sustained burst would starve the fetch entirely; this bounds
// staleness at the window regardless of event rate.
//
// Direct mutations (add/update/start error paths) still call refreshCatalog()
// immediately — the user just acted; only the event storm is coalesced.
const CATALOG_COALESCE_MS = 200

let catalogTimer: ReturnType<typeof setTimeout> | null = null
const scheduleCatalogRefresh = (): void => {
  if (catalogTimer !== null) return
  catalogTimer = setTimeout(() => {
    catalogTimer = null
    void useEngine
      .getState()
      .refreshCatalog()
      .catch(() => {})
  }, CATALOG_COALESCE_MS)
}

// ── pending: the gap no engine state can cover ──────────────────────────────
//
// Between the click and the first `state_changed`, the engine has told us
// nothing — the request is still on the wire. Every kind needs this equally
// (process, docker, compose), so it keys off the user's INTENT rather than any
// runtime signal, which is what makes it universal. Readiness deliberately
// plays no part: a worker with no declared port never becomes `ready`, and it
// must still show a settled button.

export type Intent = "starting" | "stopping" | "restarting"

/** Which arriving state ENDS each intent. `restarting` deliberately ignores
 *  `idle`: a restart is stop-then-start, so the intermediate `idle` is a
 *  waypoint, not the destination — settling there would flash a "Start" button
 *  mid-restart. */
const settles = (intent: Intent, to: RuntimeState): boolean => {
  switch (intent) {
    case "starting":
    case "restarting":
      return to === "running" || to === "crashed" || to === "errored" || to === "unmanaged"
    case "stopping":
      return to === "idle" || to === "crashed" || to === "errored"
  }
}

/** Backstop only. If the engine never reports a terminal state — it died, the
 *  socket wedged — the button must not stay disabled forever. Generous because
 *  a cold `docker pull` legitimately takes minutes. */
const PENDING_MAX_MS = 5 * 60 * 1000

interface EngineState {
  status: "connecting" | "open" | "closed"
  projects: ReadonlyArray<ProjectWithState>
  groups: ReadonlyArray<Group>
  contexts: ReadonlyArray<EnvContext>
  commands: Record<string, ReadonlyArray<NamedCommand>>
  resources: Record<string, ResourceSample>
  failures: ReadonlyArray<CrashRecord>
  /** Newest first. Fed by the live stream and backfilled once on connect. */
  activity: ReadonlyArray<ActivityEntry>
  daemon: DaemonStatusResult
  engine: EngineStatus | null
  /** Per-project URL entries + provider status, mirrored from exposure.snapshot
   *  and patched by exposure_changed events. */
  exposures: Record<string, ReadonlyArray<ExposureEntry>>
  caddy: ExposureSnapshot["caddy"] | null
  /** The last sweep of what is running that matisa did NOT start. Null until
   *  one has been taken — unlike every other slice here this one is not fed by
   *  events, because foreign processes emit none: it only changes when someone
   *  asks. `discoverySweeping` exists so the button can say it is working,
   *  since an lsof over a busy machine is visibly not instant. */
  discovery: DiscoverySnapshot | null
  discoverySweeping: boolean
  runSessions: Record<string, RunSession>
  /** Projects with a lifecycle request in flight, by the intent that started it. */
  pending: Record<string, Intent>

  markPending: (projectId: ProjectId, intent: Intent) => void
  clearPending: (projectId: ProjectId) => void
  /** Prepend a failure to the drawer's list. The engine persists its own row for
   *  each of these, so this is only about the live view — a bootstrap replaces
   *  the list with the engine's durable history. */
  recordFailure: (record: CrashRecord) => void

  // —— queries ——
  bootstrap: () => Promise<void>
  refreshCatalog: () => Promise<void>
  refreshContexts: () => Promise<void>
  refreshResources: () => Promise<void>
  refreshExposures: () => Promise<void>
  /** Sweep for unmanaged processes/containers. `force` skips the engine's TTL
   *  cache — what a user pressing Refresh means, and what a caller that just
   *  stopped something needs. */
  refreshDiscovery: (force?: boolean) => Promise<void>
  /** Re-read the Docker daemon's state. Polled, because the daemon can come
   *  and go entirely outside matisa and there is no event to hear. */
  refreshDaemon: () => Promise<void>
  loadCommands: (projectId: ProjectId) => Promise<void>
  ensureRunSession: (projectId: ProjectId) => Promise<SessionId | null>

  // —— mutations ——
  start: (projectId: ProjectId) => Promise<void>
  stop: (projectId: ProjectId) => Promise<void>
  restart: (projectId: ProjectId) => Promise<void>
  /** Force down. Deliberately NOT marked pending: a kill is over by the time the
   *  call returns, and a spinner would imply a transition to wait out — the
   *  thing the user reached for kill to escape. */
  kill: (projectId: ProjectId) => Promise<void>
  /** Acknowledge a terminal failure — `crashed`/`errored` back to `idle`. Not a
   *  lifecycle action: nothing is signalled, nothing is waited on, and the
   *  engine no-ops it from any other state. The project's recorded failures go
   *  with it, since the state and the reason for it are one thing to dismiss. */
  resetProject: (projectId: ProjectId) => Promise<void>
  /** Reclaim a project that is up outside the engine: end the holder, then
   *  start it here. The engine refuses unless the holder is recognisably this
   *  project's, so `force` is the user overriding that — never a default. */
  takeover: (projectId: ProjectId, force?: boolean) => Promise<void>
  /** Stop / start something matisa does not own. Neither adopts it into the
   *  catalog; both re-sweep so the list reflects what just happened. */
  stopUnmanaged: (ref: string) => Promise<void>
  startUnmanaged: (ref: string) => Promise<void>
  /** Forget recorded failures — one project's, or every project's. */
  clearFailures: (projectId?: ProjectId) => Promise<void>
  /** Forget activity entries — one project's (or system's), or all of them.
   *  Client-side only: this buffer is a window onto the engine's event stream,
   *  not the stream itself, so clearing it discards what this client kept. */
  clearActivity: (projectId?: ProjectId) => void
  /** Record something that happened to a SYSTEM — the daemon refusing to start,
   *  the engine socket dropping. The engine cannot report these: the first is a
   *  failure of the thing it shells out to, the second is the loss of the
   *  channel it would report over. Both land as a failure record and an activity
   *  entry under the system's own id, so the drawer shows them exactly as it
   *  shows a project's. */
  noteSystemFailure: (systemId: ProjectId, summary: string) => void
  startDaemon: () => Promise<void>
  stopDaemon: () => Promise<void>
  /** Ask the engine to shut itself down. Nothing in this client can start it
   *  again — that lives in the desktop shell — so callers must confirm first. */
  shutdownEngine: () => Promise<void>
  addProject: (project: NewProject) => Promise<boolean>
  updateProject: (projectId: ProjectId, patch: ProjectPatch) => Promise<boolean>
  removeProject: (projectId: ProjectId) => Promise<boolean>
  setGroup: (params: GroupSetParams) => Promise<boolean>
  removeGroup: (slug: GroupSlug) => Promise<boolean>
  /** Historical tail, straight from the source (docker's log store, or the run
   *  session's scrollback). Distinct from the live `log_line` ring buffer,
   *  which only ever holds what arrived while this client was watching. */
  tailLogs: (projectId: ProjectId, lines: number) => Promise<ReadonlyArray<string>>
  setEnvVar: (params: EnvSetParams) => Promise<boolean>
  unsetEnvVar: (contextId: ContextId, key: string) => Promise<boolean>
  /** Apply a whole notepad edit in one shot: upsert the changed lines, delete the
   *  removed keys, resync once. */
  applyEnvVars: (
    contextId: ContextId,
    upserts: ReadonlyArray<{ key: string; value: string; secret: boolean }>,
    removals: ReadonlyArray<string>
  ) => Promise<boolean>
  activateContext: (projectId: ProjectId, contextId: ContextId) => Promise<void>
  createContext: (name: string) => Promise<EnvContext | null>
  renameContext: (contextId: ContextId, name: string) => Promise<boolean>
  removeContext: (contextId: ContextId) => Promise<boolean>
  setCommand: (params: CommandSetParams) => Promise<boolean>
  removeCommand: (projectId: ProjectId, name: string) => Promise<void>
  runCommand: (params: CommandRunParams) => Promise<PtySession | null>
  setLanShare: (projectId: ProjectId, enabled: boolean) => Promise<boolean>

  applyEvent: (raw: unknown) => void
}

export const useEngine = create<EngineState>()((set, get) => ({
  status: "connecting",
  projects: [],
  groups: [],
  contexts: [],
  commands: {},
  resources: {},
  failures: [],
  activity: [],
  daemon: { state: "unknown" },
  engine: null,
  exposures: {},
  caddy: null,
  discovery: null,
  discoverySweeping: false,
  runSessions: {},
  pending: {},

  markPending: (projectId, intent) => {
    set((s) => ({ pending: { ...s.pending, [projectId]: intent } }))
    setTimeout(() => {
      if (get().pending[projectId] === intent) get().clearPending(projectId)
    }, PENDING_MAX_MS)
  },

  recordFailure: (record) =>
    set((s) => {
      // A retry loop produces the SAME failure over and over — same project,
      // same exit, same summary — and listing each attempt separately turns one
      // problem into five entries that push everything else out of a bounded
      // list. Consecutive repeats fold into the newest, which keeps the most
      // recent timestamp; a different failure still lands as its own row.
      const head = s.failures[0]
      const repeat =
        head !== undefined &&
        head.projectId === record.projectId &&
        head.kind === record.kind &&
        head.summary === record.summary &&
        head.exitCode === record.exitCode &&
        head.signal === record.signal
      return {
        failures: repeat
          ? [record, ...s.failures.slice(1)]
          : [record, ...s.failures].slice(0, MAX_FAILURES)
      }
    }),

  clearPending: (projectId) =>
    set((s) => {
      if (s.pending[projectId] === undefined) return s
      const next = { ...s.pending }
      delete next[projectId]
      return { pending: next }
    }),

  // ────────── queries ──────────

  bootstrap: async () => {
    // Subscribe FIRST so nothing that happens during the snapshot is missed.
    const { cursor } = await rpc.call("events.subscribe", {})
    await Promise.all([
      get().refreshCatalog(),
      get().refreshContexts(),
      get().refreshResources(),
      rpc.call("groups.list", undefined).then((groups) => set({ groups })),
      rpc.call("engine.status", undefined).then((engine) => set({ engine })),
      rpc.call("docker.daemon.status", undefined).then((daemon) => set({ daemon })),
      rpc.call("lifecycle.failures", { limit: 20 }).then((failures) => set({ failures })),
      get().refreshExposures(),
      // Swept once on connect so a project already up outside matisa reads
      // `unmanaged` from the first paint, rather than sitting there as `idle`
      // with a Run button that would fail on the port.
      get().refreshDiscovery(),
      // History, not liveness: the live subscription starts at `cursor`, so this
      // reaches BACK of it. A pull that fails costs the Activity tab its
      // backfill and nothing else — never the whole handshake.
      rpc
        .call("events.pull", { since: Math.max(0, cursor - ACTIVITY_BACKFILL), limit: ACTIVITY_BACKFILL })
        .then(({ events }) => {
          const past = events
            .map(describeEvent)
            .filter((e): e is ActivityEntry => e !== null)
            .reverse()
          // Live events may already have landed during the pull; `seq` is the
          // engine's own cursor, so a dedupe on it is exact.
          set((s) => {
            const seen = new Set(s.activity.map((e) => e.seq))
            return { activity: [...s.activity, ...past.filter((e) => !seen.has(e.seq))].slice(0, MAX_ACTIVITY) }
          })
        })
        .catch(() => {})
    ])
  },

  refreshCatalog: async () => set({ projects: await rpc.call("catalog.list", undefined) }),

  refreshContexts: async () => set({ contexts: await rpc.call("env.list", undefined) }),

  refreshExposures: async () => {
    // Tolerate an engine that predates the exposure module (version skew during
    // an upgrade): no URLs is degraded, not a failed handshake.
    try {
      const snapshot = await rpc.call("exposure.snapshot", undefined)
      const next: Record<string, ReadonlyArray<ExposureEntry>> = {}
      for (const p of snapshot.projects) next[p.projectId] = p.entries
      set({ exposures: next, caddy: snapshot.caddy })
    } catch {
      set({ exposures: {}, caddy: null })
    }
  },

  refreshDiscovery: async (force = false) => {
    set({ discoverySweeping: true })
    try {
      // The sweep also reconciles idle↔unmanaged engine-side, so the catalog is
      // re-read after it: without that the pane could name a project as held
      // while its own card still showed `idle`.
      const snapshot = await rpc.call("discovery.snapshot", { refresh: force })
      set({ discovery: snapshot })
      if (snapshot.claims.length > 0) await get().refreshCatalog()
    } catch {
      // Version skew with an engine that predates the module: no listing is
      // degraded, not a failure worth a toast on every poll.
      set({ discovery: null })
    } finally {
      set({ discoverySweeping: false })
    }
  },

  refreshDaemon: async () => {
    try {
      const daemon = await rpc.call("docker.daemon.status", undefined)
      // Identity-stable when nothing changed: this runs every 10s forever, and
      // minting a fresh object each time would re-render every subscriber of
      // `daemon` for an app sitting still.
      const current = get().daemon
      if (daemon.state === current.state && daemon.message === current.message) return
      set({ daemon })
    } catch {
      // A failed probe is not a daemon that stopped. Leave the last known
      // state alone rather than reporting a Docker outage on a dropped call.
    }
  },

  refreshResources: async () => {
    const snapshot = await rpc.call("resources.snapshot", undefined)
    // Idle steady-state — nothing running before, nothing running now. Minting
    // a fresh map identity here re-rendered every subscriber of `resources`
    // 20×/min forever, for an app doing nothing.
    if (snapshot.samples.length === 0 && Object.keys(get().resources).length === 0) return
    const next: Record<string, ResourceSample> = {}
    for (const sample of snapshot.samples) next[sample.projectId] = sample
    set({ resources: next })
  },

  loadCommands: async (projectId) => {
    const list = await rpc.call("commands.list", { id: projectId })
    set((s) => ({ commands: { ...s.commands, [projectId]: list } }))
  },

  ensureRunSession: async (projectId) => {
    const status = await rpc.call("lifecycle.status", { id: projectId })
    const sessionId = status.sessionId
    if (sessionId === undefined) return null
    set((s) => ({ runSessions: { ...s.runSessions, [projectId]: { sessionId, since: status.since } } }))
    return sessionId
  },

  // ────────── mutations ──────────

  start: async (projectId) => {
    get().markPending(projectId, "starting")
    try {
      await rpc.call("lifecycle.start", { id: projectId })
    } catch (cause) {
      get().clearPending(projectId)
      reportError(cause, "could not start")
      // A docker-daemon refusal is actionable, not fatal — resync so the daemon
      // banner reflects reality and the user can start it from the UI.
      if (codeOf(cause) === "E_DOCKER_DAEMON_REQUIRED") {
        set({ daemon: await rpc.call("docker.daemon.status", undefined) })
        return
      }
      // Anything else (a held port, a project the engine will not manage) is a
      // refusal with no state change behind it: no `errored`, no `crashed`, so
      // the toast was the only record. Log it as a failure too — dismissing a
      // toast should not erase the reason a start did nothing.
      get().recordFailure({
        projectId,
        ts: Date.now(),
        kind: "error",
        summary: describe(cause).title
      })
    }
  },

  stop: async (projectId) => {
    get().markPending(projectId, "stopping")
    try {
      await rpc.call("lifecycle.stop", { id: projectId })
    } catch (cause) {
      get().clearPending(projectId)
      reportError(cause, "could not stop")
    }
  },

  restart: async (projectId) => {
    get().markPending(projectId, "restarting")
    try {
      await rpc.call("lifecycle.restart", { id: projectId })
    } catch (cause) {
      get().clearPending(projectId)
      reportError(cause, "could not restart")
      get().recordFailure({
        projectId,
        ts: Date.now(),
        kind: "error",
        summary: describe(cause).title
      })
    }
  },

  kill: async (projectId) => {
    try {
      await rpc.call("lifecycle.kill", { id: projectId })
      // Whatever was in flight is moot — the process is gone. Clearing the
      // optimistic flag is what releases a Stop button that has been spinning
      // against a drain that was never going to finish.
      get().clearPending(projectId)
      await get().refreshCatalog()
    } catch (cause) {
      reportError(cause, "could not kill")
    }
  },

  resetProject: async (projectId) => {
    try {
      await rpc.call("lifecycle.reset", { id: projectId })
      // The state and the reason for it are dismissed together: a card back at
      // rest while its crash still sits in the Failures tab would leave the
      // triangle's tip describing a failure the user has already cleared.
      await rpc.call("lifecycle.clearFailures", { projectId })
      set((s) => ({ failures: s.failures.filter((f) => f.projectId !== projectId) }))
      get().clearPending(projectId)
      await get().refreshCatalog()
    } catch (cause) {
      reportError(cause, "could not reset")
    }
  },

  takeover: async (projectId, force = false) => {
    get().markPending(projectId, "starting")
    try {
      await rpc.call("lifecycle.takeover", { id: projectId, force })
      await get().refreshDiscovery(true)
    } catch (cause) {
      get().clearPending(projectId)
      // E_PORT_BUSY here is the engine declining to kill a process it cannot
      // tie to this project. That is a decision for the user, so it is recorded
      // rather than left in a toast they may dismiss without reading.
      reportError(cause, "could not take over")
      get().recordFailure({
        projectId,
        ts: Date.now(),
        kind: "error",
        summary: describe(cause).title
      })
    }
  },

  stopUnmanaged: async (ref) => {
    try {
      const result = await rpc.call("discovery.stop", { ref })
      toast.success(result.message)
    } catch (cause) {
      reportError(cause, "could not stop it")
    }
    await get().refreshDiscovery(true)
  },

  startUnmanaged: async (ref) => {
    try {
      const result = await rpc.call("discovery.start", { ref })
      toast.success(result.message)
    } catch (cause) {
      reportError(cause, "could not start it")
    }
    await get().refreshDiscovery(true)
  },

  clearFailures: async (projectId) => {
    const drop = (): void =>
      set((s) => ({
        failures: projectId === undefined ? [] : s.failures.filter((f) => f.projectId !== projectId)
      }))

    // A system's failures were minted here and exist nowhere else — the engine
    // has no row to forget and no id it would recognise. Clearing them is local
    // by definition.
    if (projectId !== undefined && isSystemId(projectId)) {
      drop()
      return
    }

    try {
      await rpc.call("lifecycle.clearFailures", projectId === undefined ? {} : { projectId })
      drop()
      // A global clear takes the systems' with it — "clear every recorded
      // failure" that left two rows standing would be a lie.
      if (projectId === undefined) set({ failures: [] })
    } catch (cause) {
      reportError(cause, "could not clear failures")
    }
  },

  clearActivity: (projectId) =>
    set((s) => ({
      activity: projectId === undefined ? [] : s.activity.filter((e) => e.projectId !== projectId)
    })),

  noteSystemFailure: (systemId, summary) => {
    const ts = Date.now()
    get().recordFailure({ projectId: systemId, ts, kind: "error", summary })
    set((s) => ({
      activity: [
        { seq: nextLocalSeq(), ts, projectId: systemId, kind: "crash" as const, label: "failed", detail: summary },
        ...s.activity
      ].slice(0, MAX_ACTIVITY)
    }))
  },

  startDaemon: async () => {
    set({ daemon: { state: "starting" } })
    try {
      set({ daemon: await rpc.call("docker.daemon.start", undefined) })
    } catch (cause) {
      const { title } = describe(cause)
      set({ daemon: { state: "start_failed", message: title } })
      get().noteSystemFailure(SYSTEM_IDS.docker, title)
      reportError(cause, "could not start Docker")
    }
  },

  stopDaemon: async () => {
    try {
      set({ daemon: await rpc.call("docker.daemon.stop", undefined) })
    } catch (cause) {
      get().noteSystemFailure(SYSTEM_IDS.docker, describe(cause).title)
      reportError(cause, "could not stop Docker")
      set({ daemon: await rpc.call("docker.daemon.status", undefined).catch(() => get().daemon) })
    }
  },

  shutdownEngine: async () => {
    try {
      await rpc.call("engine.shutdown", undefined)
      // No optimistic state change: the socket closing IS the confirmation, and
      // it drives `status` through the same path as any other disconnect.
      toast.success("Engine shutting down")
    } catch (cause) {
      reportError(cause, "could not shut down the engine")
    }
  },

  addProject: async (project) => {
    try {
      const added = await rpc.call("catalog.add", project)
      await get().refreshCatalog()
      toast.success(`Added ${added.name}`)
      return true
    } catch (cause) {
      reportError(cause, "could not add project")
      return false
    }
  },

  updateProject: async (projectId, patch) => {
    try {
      const saved = await rpc.call("catalog.update", { id: projectId, patch })
      await get().refreshCatalog()
      toast.success(`Updated ${saved.name}`)
      return true
    } catch (cause) {
      reportError(cause, "could not update project")
      return false
    }
  },

  removeProject: async (projectId) => {
    const name = get().projects.find((p) => p.id === projectId)?.name ?? "project"
    try {
      await rpc.call("catalog.remove", { id: projectId })
      await get().refreshCatalog()
      toast.success(`Removed ${name}`)
      return true
    } catch (cause) {
      reportError(cause, "could not remove project")
      return false
    }
  },

  setGroup: async (params) => {
    try {
      await rpc.call("groups.set", params)
      set({ groups: await rpc.call("groups.list", undefined) })
      return true
    } catch (cause) {
      reportError(cause, "could not save group")
      return false
    }
  },

  removeGroup: async (slug) => {
    try {
      // Ungroup the members FIRST. `groups.remove` drops the group row and
      // nothing else, so a project left pointing at a dead slug would reappear
      // in the tree under the raw slug as its own heading — the sidebar's
      // orphan handling exists for stale data, not as a resting state.
      const members = get().projects.filter((p) => p.groupSlug === slug)
      for (const p of members) {
        await rpc.call("catalog.update", { id: p.id, patch: { groupSlug: null } })
      }
      await rpc.call("groups.remove", { slug })
      await Promise.all([
        rpc.call("groups.list", undefined).then((groups) => set({ groups })),
        get().refreshCatalog()
      ])
      return true
    } catch (cause) {
      reportError(cause, "could not remove group")
      return false
    }
  },

  tailLogs: async (projectId, lines) => {
    try {
      const result = await rpc.call("logs.tail", { projectId, lines })
      return result.lines
    } catch (cause) {
      reportError(cause, "could not read logs")
      return []
    }
  },

  setEnvVar: async (params) => {
    try {
      await rpc.call("env.set", params)
      await get().refreshContexts()
      return true
    } catch (cause) {
      reportError(cause, "could not set variable")
      return false
    }
  },

  unsetEnvVar: async (contextId, key) => {
    try {
      await rpc.call("env.unset", { contextId, key })
      await get().refreshContexts()
      return true
    } catch (cause) {
      reportError(cause, "could not remove variable")
      return false
    }
  },

  applyEnvVars: async (contextId, upserts, removals) => {
    if (upserts.length === 0 && removals.length === 0) return true
    try {
      for (const u of upserts) {
        await rpc.call("env.set", { contextId, key: u.key, value: u.value, secret: u.secret })
      }
      for (const key of removals) await rpc.call("env.unset", { contextId, key })
      await get().refreshContexts()
      return true
    } catch (cause) {
      reportError(cause, "could not save environment")
      return false
    }
  },

  activateContext: async (projectId, contextId) => {
    try {
      await rpc.call("env.use", { projectId, contextId })
      await get().refreshCatalog()
    } catch (cause) {
      reportError(cause, "could not switch environment")
    }
  },

  createContext: async (name) => {
    try {
      const created = await rpc.call("env.create", { name })
      await get().refreshContexts()
      return created
    } catch (cause) {
      reportError(cause, "could not add environment")
      return null
    }
  },

  renameContext: async (contextId, name) => {
    try {
      await rpc.call("env.rename", { contextId, name })
      await get().refreshContexts()
      return true
    } catch (cause) {
      reportError(cause, "could not rename environment")
      return false
    }
  },

  removeContext: async (contextId) => {
    try {
      await rpc.call("env.remove", { contextId })
      // The engine detaches every project that was pointed at it, so the catalog
      // is stale too — not just the context list.
      await Promise.all([get().refreshContexts(), get().refreshCatalog()])
      return true
    } catch (cause) {
      reportError(cause, "could not delete environment")
      return false
    }
  },

  setCommand: async (params) => {
    try {
      await rpc.call("commands.set", params)
      await get().loadCommands(params.projectId)
      return true
    } catch (cause) {
      reportError(cause, "could not save command")
      return false
    }
  },

  removeCommand: async (projectId, name) => {
    try {
      await rpc.call("commands.remove", { projectId, name })
      await get().loadCommands(projectId)
    } catch (cause) {
      reportError(cause, `could not remove "${name}"`)
    }
  },

  runCommand: async (params) => {
    try {
      return await rpc.call("commands.run", params)
    } catch (cause) {
      reportError(cause, `could not run "${params.name}"`)
      return null
    }
  },

  setLanShare: async (projectId, enabled) => {
    try {
      const { entries } = await rpc.call("exposure.lan.set", { id: projectId, enabled })
      set((s) => ({ exposures: { ...s.exposures, [projectId]: entries } }))
      return true
    } catch (cause) {
      reportError(cause, enabled ? "could not share on network" : "could not stop sharing")
      return false
    }
  },

  // ────────── events ──────────

  applyEvent: (raw) => {
    const decoded = decodeEvent(raw)
    if (decoded._tag === "None") return
    const event = decoded.value

    const entry = describeEvent(event)
    if (entry !== null) set((s) => ({ activity: [entry, ...s.activity].slice(0, MAX_ACTIVITY) }))

    const patch = (projectId: ProjectId, f: (p: ProjectWithState) => ProjectWithState): void =>
      set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? f(p) : p)) }))

    switch (event.type) {
      case "state_changed": {
        const to: RuntimeState = event.payload.to
        patch(event.projectId, (p) => ({ ...p, state: to }))

        // `errored` is a failure the engine could not recover from — the FSM
        // says so but emits no `crashed` event, so without this the Failures
        // tab would stay empty while the project sits there red.
        if (to === "errored") {
          get().recordFailure({
            projectId: event.projectId,
            ts: event.ts,
            kind: "error",
            ...(event.payload.reason !== undefined ? { summary: event.payload.reason } : {})
          })
        }

        // Hand off from optimistic pending to engine-reported truth. From here
        // `starting`/`stopping` carry the loading state on their own, so the
        // optimistic flag is only ever in play for the round-trip.
        const intent = get().pending[event.projectId]
        if (intent !== undefined && settles(intent, to)) get().clearPending(event.projectId)

        // Runtime identity (pid/session) is not carried on the event; resync the
        // authoritative row rather than guessing — coalesced, so a burst of
        // transitions costs one fetch per window.
        scheduleCatalogRefresh()
        break
      }
      case "health_changed": {
        const health: Health = event.payload.health
        patch(event.projectId, (p) => ({ ...p, health }))
        break
      }
      case "crashed": {
        const record: CrashRecord = {
          projectId: event.projectId,
          ts: event.ts,
          kind: "crash",
          exitCode: event.payload.exitCode,
          signal: event.payload.signal,
          summary: event.payload.summary,
          logTail: event.payload.logTail
        }
        // No toast. The card already says it — the failure triangle, with the
        // reason on hover and a reset beside it — and a popup for something
        // already on screen is a second copy you have to dismiss. The record
        // below is the durable account; the Failures tab is where you read it.
        get().recordFailure(record)
        break
      }
      case "catalog_changed": {
        scheduleCatalogRefresh()
        break
      }
      case "exposure_changed": {
        const entries = event.payload.entries
        set((s) => {
          if (entries.length === 0) {
            const next = { ...s.exposures }
            delete next[event.projectId]
            return { exposures: next }
          }
          return { exposures: { ...s.exposures, [event.projectId]: entries } }
        })
        break
      }
      case "log_line":
        // Process projects speak through their PTY; log_line is how docker and
        // compose output reaches the client. Ring-buffered in its own store so
        // a chatty container re-renders the log pane, not this mirror.
        useLogs.getState().append(event.projectId, {
          ts: event.ts,
          stream: event.payload.stream,
          line: event.payload.line,
          ...(event.payload.service !== undefined ? { service: event.payload.service } : {})
        })
        break
    }
  }
}))

// —— wiring: one subscription for the whole app ——

rpc.onStatus((status) => {
  const was = useEngine.getState().status
  // A dropped socket means no transition will ever arrive for anything in
  // flight. Clear it rather than leave every button disabled behind a
  // connection that is gone.
  if (status !== "open") useEngine.setState({ status, pending: {} })
  else useEngine.setState({ status })

  // Only the transition OUT of a working connection is the event. The client
  // reconnects on a backoff curve, so `closed` and `connecting` alternate for as
  // long as the engine is down — recording each one would turn a single outage
  // into a screenful of identical rows.
  if (was === "open" && status !== "open") {
    useEngine.getState().noteSystemFailure(SYSTEM_IDS.engine, `lost the connection to ${engineUrl()}`)
  }
})

rpc.onNotify((n) => {
  if (n.method === "events.notify") useEngine.getState().applyEvent(n.params)
})

rpc.onOpen(() => {
  void useEngine
    .getState()
    .bootstrap()
    .catch((cause) => reportError(cause, "engine handshake failed"))
})

// ────────────────────────────────────────────────────────────────────────────
// The two polls.
//
// Everything else in this store is event-driven, which is right for anything
// the engine causes. These two are things it only OBSERVES, and neither has an
// event stream to subscribe to.
//
// Resources: `ps` has no push channel, so sampling is the only option.
//
// The Docker daemon: it can start or stop entirely outside matisa — from the
// menu bar, from `colima`, from a reboot — and the engine finds out only by
// running `docker info`. Without this the daemon status was read exactly three
// times (on connect, on a start refused for want of it, and on the user's own
// start/stop press), so Docker coming up while the app was open was never
// noticed and every docker project stayed unstartable behind a banner that was
// no longer true.
//
// Ten seconds, not three: `docker info` shells out with its own 3s timeout,
// and a daemon that just came up is not urgent the way a CPU reading is. The
// engine short-circuits this to a cached answer while a start it initiated is
// still in flight, so polling cannot disturb the starting spinner.
// ────────────────────────────────────────────────────────────────────────────
const RESOURCE_POLL_MS = 3_000
const DAEMON_POLL_MS = 10_000

setInterval(() => {
  if (useEngine.getState().status === "open") void useEngine.getState().refreshResources().catch(() => {})
}, RESOURCE_POLL_MS)

setInterval(() => {
  if (useEngine.getState().status === "open") void useEngine.getState().refreshDaemon()
}, DAEMON_POLL_MS)
