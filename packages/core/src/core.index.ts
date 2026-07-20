// @matisa/core — the single source of truth for every shape crossing the
// engine↔client socket. Engine and clients both derive their wire types from
// here; nothing else defines a transport shape.

export * from "./core.schemas.js"
export * from "./core.events.js"
export * from "./core.errors.js"
export * from "./core.methods.js"
