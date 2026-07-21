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
  type EngineStatus,
  type EnvContext,
  type EnvSetParams,
  type Group,
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
import { rpc, RpcError } from "~/rpc/rpc.client"
import { useLogs } from "~/store/store.logs"

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
  daemon: DaemonStatusResult
  engine: EngineStatus | null
  runSessions: Record<string, RunSession>
  /** Projects with a lifecycle request in flight, by the intent that started it. */
  pending: Record<string, Intent>

  markPending: (projectId: ProjectId, intent: Intent) => void
  clearPending: (projectId: ProjectId) => void

  // —— queries ——
  bootstrap: () => Promise<void>
  refreshCatalog: () => Promise<void>
  refreshContexts: () => Promise<void>
  refreshResources: () => Promise<void>
  loadCommands: (projectId: ProjectId) => Promise<void>
  ensureRunSession: (projectId: ProjectId) => Promise<SessionId | null>

  // —— mutations ——
  start: (projectId: ProjectId) => Promise<void>
  stop: (projectId: ProjectId) => Promise<void>
  restart: (projectId: ProjectId) => Promise<void>
  startDaemon: () => Promise<void>
  addProject: (project: NewProject) => Promise<boolean>
  updateProject: (projectId: ProjectId, patch: ProjectPatch) => Promise<boolean>
  setEnvVar: (params: EnvSetParams) => Promise<boolean>
  activateContext: (projectId: ProjectId, contextId: ContextId) => Promise<void>
  createContext: (name: string) => Promise<EnvContext | null>
  renameContext: (contextId: ContextId, name: string) => Promise<boolean>
  removeContext: (contextId: ContextId) => Promise<boolean>
  setCommand: (params: CommandSetParams) => Promise<boolean>
  removeCommand: (projectId: ProjectId, name: string) => Promise<void>
  runCommand: (params: CommandRunParams) => Promise<PtySession | null>

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
  daemon: { state: "unknown" },
  engine: null,
  runSessions: {},
  pending: {},

  markPending: (projectId, intent) => {
    set((s) => ({ pending: { ...s.pending, [projectId]: intent } }))
    setTimeout(() => {
      if (get().pending[projectId] === intent) get().clearPending(projectId)
    }, PENDING_MAX_MS)
  },

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
    await rpc.call("events.subscribe", {})
    await Promise.all([
      get().refreshCatalog(),
      get().refreshContexts(),
      get().refreshResources(),
      rpc.call("groups.list", undefined).then((groups) => set({ groups })),
      rpc.call("engine.status", undefined).then((engine) => set({ engine })),
      rpc.call("docker.daemon.status", undefined).then((daemon) => set({ daemon })),
      rpc.call("lifecycle.failures", { limit: 20 }).then((failures) => set({ failures }))
    ])
  },

  refreshCatalog: async () => set({ projects: await rpc.call("catalog.list", undefined) }),

  refreshContexts: async () => set({ contexts: await rpc.call("env.list", undefined) }),

  refreshResources: async () => {
    const snapshot = await rpc.call("resources.snapshot", undefined)
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
      }
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
    }
  },

  startDaemon: async () => {
    set({ daemon: { state: "starting" } })
    try {
      set({ daemon: await rpc.call("docker.daemon.start", undefined) })
    } catch (cause) {
      const { title } = describe(cause)
      set({ daemon: { state: "start_failed", message: title } })
      reportError(cause, "could not start Docker")
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

  // ────────── events ──────────

  applyEvent: (raw) => {
    const decoded = decodeEvent(raw)
    if (decoded._tag === "None") return
    const event = decoded.value

    const patch = (projectId: ProjectId, f: (p: ProjectWithState) => ProjectWithState): void =>
      set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? f(p) : p)) }))

    switch (event.type) {
      case "state_changed": {
        const to: RuntimeState = event.payload.to
        patch(event.projectId, (p) => ({ ...p, state: to }))

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
          exitCode: event.payload.exitCode,
          signal: event.payload.signal,
          summary: event.payload.summary,
          logTail: event.payload.logTail
        }
        set((s) => ({ failures: [record, ...s.failures].slice(0, 50) }))
        const name = get().projects.find((p) => p.id === event.projectId)?.name ?? "project"
        toast.error(`${name}: ${event.payload.summary ?? "exited unexpectedly"}`, {
          description: event.payload.logTail
        })
        break
      }
      case "catalog_changed": {
        scheduleCatalogRefresh()
        break
      }
      case "exposure_changed": {
        patch(event.projectId, (p) => ({ ...p, exposure: event.payload.exposure }))
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
  // A dropped socket means no transition will ever arrive for anything in
  // flight. Clear it rather than leave every button disabled behind a
  // connection that is gone.
  if (status !== "open") useEngine.setState({ status, pending: {} })
  else useEngine.setState({ status })
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

// Resource sampling is a poll by nature (ps / docker stats expose no event
// stream). Everything else in this store is event-driven.
const RESOURCE_POLL_MS = 3_000
setInterval(() => {
  if (useEngine.getState().status === "open") void useEngine.getState().refreshResources().catch(() => {})
}, RESOURCE_POLL_MS)
