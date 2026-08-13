import { Effect } from "effect"
import { EventsRepo, RuntimeRepo } from "@matisa/store"
import { AppConfig } from "../../config/config.app-config.js"
import { Catalog } from "../../modules/catalog/catalog.services.js"
import { Discovery } from "../../modules/discovery/discovery.index.js"
import { DockerDaemon } from "../../modules/docker/docker.daemon.js"
import { Exposure } from "../../modules/exposure/exposure.index.js"
import { PtyManager } from "../../modules/pty/pty.services.js"
import { Resources } from "../../modules/resources/resources.services.js"
import { Supervisor } from "../../modules/supervisor/supervisor.services.js"
import { EventsHub } from "../server.events-hub.js"
import type { Handlers } from "../server.dispatcher.js"
import { catalogHandlers } from "./handlers.catalog.js"
import { discoveryHandlers } from "./handlers.discovery.js"
import { engineHandlers } from "./handlers.engine.js"
import { eventsHandlers } from "./handlers.events.js"
import { exposureHandlers } from "./handlers.exposure.js"
import { fsHandlers } from "./handlers.fs.js"
import { lifecycleHandlers } from "./handlers.lifecycle.js"
import { ptyHandlers } from "./handlers.pty.js"

// The handler registry. Assembling the namespace maps into a single
// Record<Method, Handler> makes the compiler enforce that every method in the
// core registry has exactly one handler — the map must stay in sync with the
// shared Method type or this fails to build (contracts-single-source).

export const makeHandlers: Effect.Effect<
  Handlers,
  never,
  | Catalog
  | Supervisor
  | Discovery
  | Exposure
  | EventsHub
  | PtyManager
  | DockerDaemon
  | Resources
  | AppConfig
  | EventsRepo
  | RuntimeRepo
> = Effect.gen(function* () {
  const catalog = yield* Catalog
  const supervisor = yield* Supervisor
  const discovery = yield* Discovery
  const exposure = yield* Exposure
  const hub = yield* EventsHub
  const pty = yield* PtyManager
  const daemon = yield* DockerDaemon
  const resources = yield* Resources
  const config = yield* AppConfig
  const eventsRepo = yield* EventsRepo
  const runtime = yield* RuntimeRepo
  const startedAt = Date.now()

  const handlers: Handlers = {
    ...catalogHandlers(catalog, pty),
    ...lifecycleHandlers(supervisor, runtime),
    ...discoveryHandlers(discovery),
    ...eventsHandlers(hub),
    ...ptyHandlers(pty),
    ...engineHandlers(config, startedAt, daemon, resources, catalog, supervisor, pty),
    ...exposureHandlers(exposure),
    ...fsHandlers()
  }
  return handlers
})
