import { Layer } from "effect"
import { ProjectsRepoLive } from "./repositories.projects.js"
import { EnvRepoLive } from "./repositories.env.js"
import { EventsRepoLive } from "./repositories.events.js"
import { RuntimeRepoLive } from "./repositories.runtime.js"
import { CommandsRepoLive } from "./repositories.commands.js"
import { GroupsRepoLive } from "./repositories.groups.js"
import { ExposuresRepoLive } from "./repositories.exposures.js"
import { SettingsRepoLive } from "./repositories.settings.js"

// Barrel of every repository tag, its Live layer, and the inferred row/param
// types the engine consumes.
export * from "./repositories.projects.js"
export * from "./repositories.env.js"
export * from "./repositories.events.js"
export * from "./repositories.runtime.js"
export * from "./repositories.commands.js"
export * from "./repositories.groups.js"
export * from "./repositories.exposures.js"
export * from "./repositories.settings.js"

// All repositories over a shared Store. Requires `Store` in context — provided
// by StoreClientLive in the store.index barrel.
export const RepositoriesLive = Layer.mergeAll(
  ProjectsRepoLive,
  EnvRepoLive,
  EventsRepoLive,
  RuntimeRepoLive,
  CommandsRepoLive,
  GroupsRepoLive,
  ExposuresRepoLive,
  SettingsRepoLive
)
