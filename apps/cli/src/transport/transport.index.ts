// Barrel for the transport concern. Composes the scoped socket client into the
// EngineClientLive layer consumed by main.ts, and re-exports the typed caller,
// the two event paths, and the pty bridge.

import { EngineClientBase } from "./transport.client.js"

export { EngineClient, nextRpcId } from "./transport.client.js"
export type { Connection } from "./transport.client.js"
export { call } from "./transport.control.js"
export * as Events from "./transport.events.js"
export * as Pty from "./transport.pty.js"
export * from "./transport.errors.js"
export type { TransportError } from "./transport.errors.js"

/** The engine-facing client layer (scoped socket + demux fiber). */
export const EngineClientLive = EngineClientBase
