import { Effect } from "effect"
import { Catalog } from "../../modules/catalog/catalog.services.js"
import { PtyManager } from "../../modules/pty/pty.services.js"
import { Supervisor } from "../../modules/supervisor/supervisor.services.js"
import { EventsHub } from "../server.events-hub.js"
import type { Handlers } from "../server.dispatcher.js"
import { catalogHandlers } from "./handlers.catalog.js"
import { eventsHandlers } from "./handlers.events.js"
import { lifecycleHandlers } from "./handlers.lifecycle.js"
import { ptyHandlers } from "./handlers.pty.js"

// The handler registry. Assembling the four namespace maps into a single
// Record<Method, Handler> makes the compiler enforce that every method in the
// core registry has exactly one handler — the map must stay in sync with the
// shared Method type or this fails to build (contracts-single-source).

export const makeHandlers: Effect.Effect<
  Handlers,
  never,
  Catalog | Supervisor | EventsHub | PtyManager
> = Effect.gen(function* () {
  const catalog = yield* Catalog
  const supervisor = yield* Supervisor
  const hub = yield* EventsHub
  const pty = yield* PtyManager

  const handlers: Handlers = {
    ...catalogHandlers(catalog),
    ...lifecycleHandlers(supervisor),
    ...eventsHandlers(hub),
    ...ptyHandlers(pty)
  }
  return handlers
})
