import type { ById } from "@matisa/core"
import type { SupervisorShape } from "../../modules/supervisor/supervisor.services.js"
import type { Handlers } from "../server.dispatcher.js"

// lifecycle.start/stop/restart/status → the Supervisor service.

export const lifecycleHandlers = (
  supervisor: SupervisorShape
): Pick<Handlers, "lifecycle.start" | "lifecycle.stop" | "lifecycle.restart" | "lifecycle.status"> => ({
  "lifecycle.start": (params) => supervisor.start((params as ById).id),
  "lifecycle.stop": (params) => supervisor.stop((params as ById).id),
  "lifecycle.restart": (params) => supervisor.restart((params as ById).id),
  "lifecycle.status": (params) => supervisor.status((params as ById).id)
})
