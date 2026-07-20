import type {
  ById,
  CatalogUpdateParams,
  EnvSetParams,
  EnvUseParams,
  NewProject
} from "@matisa/core"
import type { CatalogShape } from "../../modules/catalog/catalog.services.js"
import type { Handlers } from "../server.dispatcher.js"

// projects.* + env.* handlers → the Catalog service. Thin adapters: the params
// are already Schema-decoded by the dispatcher, so each handler just narrows and
// forwards. No business logic here (thin-clients / thin-handlers).

export const catalogHandlers = (
  catalog: CatalogShape
): Pick<
  Handlers,
  "catalog.add" | "catalog.list" | "catalog.update" | "catalog.remove" | "env.set" | "env.list" | "env.use"
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
  "env.use": (params) => catalog.envUse(params as EnvUseParams)
})
