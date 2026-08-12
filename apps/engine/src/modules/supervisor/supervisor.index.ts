// Barrel for the supervisor module — the Supervisor tag/service, the pure FSM,
// the errors, and the boot reconciliation Effect main.ts wires ahead of the
// socket. Lifecycle wire shapes (Accepted / RuntimeStatus) live in @matisa/core.

export * from "./supervisor.errors.js"
export * from "./supervisor.machine.js"
export * from "./supervisor.services.js"
export { reconcile } from "./supervisor.reconcile.js"
export { SupervisorLive } from "./supervisor.services.js"
