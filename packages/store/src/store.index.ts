import { Layer } from "effect"
import { StoreClientLive } from "./store.client.js"
import { RepositoriesLive } from "./repositories/repositories.index.js"

// @matisa/store — the sole owner of the SQLite handle. The engine is its only
// consumer; clients never touch sqlite. Everything the engine needs is here.
export * from "./store.errors.js"
export * from "./store.client.js"
export * from "./db.schema/db.index.js"
export * from "./repositories/repositories.index.js"

// The one layer the engine provides: opens/migrates the DB (StoreClientLive)
// and wires every repository on top. Output provides Store + all repo tags,
// requires nothing.
export const StoreLive = RepositoriesLive.pipe(Layer.provideMerge(StoreClientLive))
