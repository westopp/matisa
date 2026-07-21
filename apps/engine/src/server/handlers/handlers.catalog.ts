import type {
  ByContextId,
  ById,
  BySlug,
  CatalogUpdateParams,
  CommandRefParams,
  CommandRunParams,
  CommandSetParams,
  EnvCreateParams,
  EnvRenameParams,
  EnvSetParams,
  EnvUseParams,
  GroupSetParams,
  NewProject
} from "@matisa/core"
import { Effect } from "effect"
import type { CatalogShape } from "../../modules/catalog/catalog.services.js"
import type { PtyManagerShape } from "../../modules/pty/pty.services.js"
import { bridgeSessionToConnection } from "../server.pty-bridge.js"
import type { Handlers } from "../server.dispatcher.js"

// projects.* + env.* handlers → the Catalog service. Thin adapters: the params
// are already Schema-decoded by the dispatcher, so each handler just narrows and
// forwards. No business logic here (thin-clients / thin-handlers).

export const catalogHandlers = (
  catalog: CatalogShape,
  pty: PtyManagerShape
): Pick<
  Handlers,
  | "catalog.add" | "catalog.list" | "catalog.update" | "catalog.remove"
  | "env.set" | "env.list" | "env.use" | "env.create" | "env.rename" | "env.remove"
  | "commands.set" | "commands.list" | "commands.remove" | "commands.run"
  | "groups.set" | "groups.list" | "groups.remove"
> => ({
  "catalog.add": (params) => catalog.add(params as NewProject),
  "catalog.list": () => catalog.list(),
  "catalog.update": (params) => {
    const p = params as CatalogUpdateParams
    return catalog.update(p.id, p.patch)
  },
  "catalog.remove": (params) => catalog.remove((params as ById).id),
  "env.set": (params) => catalog.envSet(params as EnvSetParams),
  "env.list": () => catalog.envList(),
  "env.use": (params) => catalog.envUse(params as EnvUseParams),
  "env.create": (params) => catalog.envCreate(params as EnvCreateParams),
  "env.rename": (params) => catalog.envRename(params as EnvRenameParams),
  "env.remove": (params) => catalog.envRemove((params as ByContextId).contextId),
  "commands.set": (params) => catalog.commandSet(params as CommandSetParams),
  "commands.list": (params) => catalog.commandList((params as ById).id),
  "commands.remove": (params) => {
    const p = params as CommandRefParams
    return catalog.commandRemove(p.projectId, p.name)
  },
  "commands.run": (params, conn) =>
    Effect.gen(function* () {
      // Like pty.open: create the session AND bridge it onto the calling
      // connection — the client reads pty.output immediately after the ack.
      const session = yield* catalog.commandRun(params as CommandRunParams)
      yield* bridgeSessionToConnection(pty, session.sessionId, conn)
      return session
    }),
  "groups.set": (params) => catalog.groupSet(params as GroupSetParams),
  "groups.list": () => catalog.groupList(),
  "groups.remove": (params) => catalog.groupRemove((params as BySlug).slug)
})
