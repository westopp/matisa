import { Effect } from "effect"
import type { ById, FailuresParams } from "@matisa/core"
import type { RuntimeRepoShape } from "@matisa/store"
import type { SupervisorShape } from "../../modules/supervisor/supervisor.services.js"
import type { Handlers } from "../server.dispatcher.js"

// lifecycle.start/stop/restart/status → the Supervisor service.
// lifecycle.failures → crash_history: the queryable "always know WHY" surface.

export const lifecycleHandlers = (
  supervisor: SupervisorShape,
  runtime: RuntimeRepoShape
): Pick<
  Handlers,
  | "lifecycle.start"
  | "lifecycle.stop"
  | "lifecycle.restart"
  | "lifecycle.kill"
  | "lifecycle.status"
  | "lifecycle.failures"
> => ({
  "lifecycle.start": (params) => supervisor.start((params as ById).id),
  "lifecycle.stop": (params) => supervisor.stop((params as ById).id),
  "lifecycle.restart": (params) => supervisor.restart((params as ById).id),
  "lifecycle.kill": (params) => supervisor.kill((params as ById).id),
  "lifecycle.status": (params) => supervisor.status((params as ById).id),
  "lifecycle.failures": (params) => {
    const p = params as FailuresParams
    return runtime.recentCrashes(p.projectId, p.limit).pipe(Effect.orDie)
  }
})
