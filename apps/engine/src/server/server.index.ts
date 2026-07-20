// SocketLive — the transport layer main.ts provides last (after state is
// coherent). Composes socket acquire + dispatcher + handlers; the EventsHub is
// provided as a peer layer in the composition root.

export { EventsHub, EventsHubLive } from "./server.events-hub.js"
export { SocketServer, ServerLive } from "./server.socket.js"
export type { Connection, Dispatch, Handler, Handlers } from "./server.dispatcher.js"
