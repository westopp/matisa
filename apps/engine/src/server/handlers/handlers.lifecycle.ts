import { Effect } from "effect"
import type { ById, ClearFailuresParams, FailuresParams, TakeoverParams } from "@matisa/core"
import type { RuntimeRepoShape } from "@matisa/store"
import type { SupervisorShape } from "../../modules/supervisor/supervisor.services.js"
import { configChanged } from "../../shared/events.js"
import type { EventsHubShape } from "../server.events-hub.js"
import type { Handlers } from "../server.dispatcher.js"

// lifecycle.start/stop/restart/status → the Supervisor service.
// lifecycle.failures → crash_history: the queryable "always know WHY" surface.

export const lifecycleHandlers = (
  supervisor: SupervisorShape,
  runtime: RuntimeRepoShape,
  events: EventsHubShape
): Pick<
  Handlers,
  | "lifecycle.start"
  | "lifecycle.stop"
  | "lifecycle.restart"
  | "lifecycle.kill"
  | "lifecycle.reset"
  | "lifecycle.takeover"
  | "lifecycle.status"
  | "lifecycle.failures"
  | "lifecycle.clearFailures"
> => ({
  "lifecycle.start": (params) => supervisor.start((params as ById).id),
  "lifecycle.stop": (params) => supervisor.stop((params as ById).id),
  "lifecycle.restart": (params) => supervisor.restart((params as ById).id),
  "lifecycle.kill": (params) => supervisor.kill((params as ById).id),
  "lifecycle.reset": (params) => supervisor.reset((params as ById).id),
  "lifecycle.takeover": (params) => {
    const p = params as TakeoverParams
    return supervisor.takeover(p.id, p.force)
  },
  "lifecycle.status": (params) => supervisor.status((params as ById).id),
  "lifecycle.failures": (params) => {
    const p = params as FailuresParams
    return runtime.recentCrashes(p.projectId, p.limit).pipe(Effect.orDie)
  },
  // Announced because the history is shared: one client clearing it leaves
  // every other client's Failures tab listing rows the engine no longer has.
  // The id is the project scope, absent for a clear-all.
  "lifecycle.clearFailures": (params) => {
    const p = params as ClearFailuresParams
    return runtime.clearCrashes(p.projectId).pipe(
      Effect.tap(() => events.emit(configChanged("failures", "removed", p.projectId))),
      Effect.map((cleared) => ({ cleared })),
      Effect.orDie
    )
  }
})
