import { Context, Effect, Layer, Option, Redacted } from "effect"
import {
  type EngineError,
  type EnvContext,
  type EnvVar,
  type NewProject,
  type Project,
  type ProjectId,
  type ProjectPatch,
  type ProjectWithState,
  type EnvSetParams,
  type EnvUseParams
} from "@matisa/core"
import {
  EnvRepo,
  ProjectsRepo,
  RuntimeRepo,
  type RuntimeSnapshot
} from "@matisa/store"
import { toEngineError } from "../../shared/error-map.js"
import { catalogChanged } from "../../shared/events.js"
import { EventsHub } from "../../server/server.events-hub.js"
import { Keychain } from "./providers/catalog.providers.keychain.types.js"

// ────────────────────────────────────────────────────────────────────────────
// Catalog — the configuration domain. Project/env CRUD delegated to the Store
// repositories, secret values stashed via the Keychain (only a ref is persisted),
// and a catalog_changed event emitted on every mutation. All faults surface as
// @matisa/core EngineError so the dispatcher stays uniform.
// ────────────────────────────────────────────────────────────────────────────

export interface CatalogShape {
  readonly add: (input: NewProject) => Effect.Effect<Project, EngineError>
  readonly list: () => Effect.Effect<ReadonlyArray<ProjectWithState>, EngineError>
  readonly update: (id: ProjectId, patch: ProjectPatch) => Effect.Effect<Project, EngineError>
  readonly remove: (id: ProjectId) => Effect.Effect<void, EngineError>
  readonly envSet: (params: EnvSetParams) => Effect.Effect<EnvContext, EngineError>
  readonly envList: () => Effect.Effect<ReadonlyArray<EnvContext>, EngineError>
  readonly envUse: (params: EnvUseParams) => Effect.Effect<ProjectWithState, EngineError>
}

export class Catalog extends Context.Tag("Catalog")<Catalog, CatalogShape>() {}

const withState = (project: Project, snapshot: Option.Option<RuntimeSnapshot>): ProjectWithState =>
  Option.match(snapshot, {
    onNone: () => ({ ...project, state: "idle" as const, pid: undefined }),
    onSome: (s) => ({ ...project, state: s.state, pid: s.pid })
  })

const make = Effect.gen(function* () {
  const projects = yield* ProjectsRepo
  const env = yield* EnvRepo
  const runtime = yield* RuntimeRepo
  const events = yield* EventsHub
  const keychain = yield* Keychain

  const add: CatalogShape["add"] = (input) =>
    projects.create(input).pipe(
      Effect.mapError(toEngineError),
      Effect.tap((p) => events.emit(catalogChanged(p.id, "added")))
    )

  const list: CatalogShape["list"] = () =>
    Effect.gen(function* () {
      const [ps, snaps] = yield* Effect.all([projects.list(), runtime.all()]).pipe(
        Effect.mapError(toEngineError)
      )
      const byId = new Map(snaps.map((s) => [s.projectId as string, s]))
      return ps.map((p) => withState(p, Option.fromNullable(byId.get(p.id as string))))
    })

  const update: CatalogShape["update"] = (id, patch) =>
    projects.update(id, patch).pipe(
      Effect.mapError(toEngineError),
      Effect.tap((p) => events.emit(catalogChanged(p.id, "updated")))
    )

  const remove: CatalogShape["remove"] = (id) =>
    projects.remove(id).pipe(
      Effect.mapError(toEngineError),
      Effect.tap(() => events.emit(catalogChanged(id, "removed")))
    )

  const envSet: CatalogShape["envSet"] = (params) =>
    Effect.gen(function* () {
      let v: EnvVar
      if (params.secret) {
        const secretRef = `${params.contextId}:${params.key}`
        yield* keychain
          .set(secretRef, Redacted.make(params.value))
          .pipe(Effect.mapError(toEngineError))
        v = { kind: "secret", key: params.key, secretRef }
      } else {
        v = { kind: "plain", key: params.key, value: params.value }
      }
      return yield* env
        .set({ contextId: params.contextId, var: v })
        .pipe(Effect.mapError(toEngineError))
    })

  const envList: CatalogShape["envList"] = () => env.list().pipe(Effect.mapError(toEngineError))

  const envUse: CatalogShape["envUse"] = (params) =>
    Effect.gen(function* () {
      yield* env.useContext(params.projectId, params.contextId).pipe(Effect.mapError(toEngineError))
      const project = yield* projects.get(params.projectId).pipe(Effect.mapError(toEngineError))
      const snap = yield* runtime.getState(params.projectId).pipe(Effect.mapError(toEngineError))
      return withState(project, snap)
    })

  return Catalog.of({ add, list, update, remove, envSet, envList, envUse })
})

export const CatalogLive = Layer.effect(Catalog, make)
