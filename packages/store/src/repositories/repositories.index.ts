import { Layer } from "effect"
import { ProjectsRepoLive } from "./repositories.projects.js"
import { EnvRepoLive } from "./repositories.env.js"
import { EventsRepoLive } from "./repositories.events.js"
import { RuntimeRepoLive } from "./repositories.runtime.js"

// Barrel of every repository tag, its Live layer, and the inferred row/param
// types the engine consumes.
export * from "./repositories.projects.js"
export * from "./repositories.env.js"
export * from "./repositories.events.js"
export * from "./repositories.runtime.js"

// All repositories over a shared Store. Requires `Store` in context — provided
// by StoreClientLive in the store.index barrel.
export const RepositoriesLive = Layer.mergeAll(
  ProjectsRepoLive,
  EnvRepoLive,
  EventsRepoLive,
  RuntimeRepoLive
)
