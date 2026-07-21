import { Context, Effect, Layer, Option } from "effect"
import {
  BASE_CONTEXT_ID,
  SessionId,
  ValidationError,
  type CommandRunParams,
  type CommandSetParams,
  type ContextId,
  type EngineError,
  type EnvContext,
  type EnvCreateParams,
  type EnvRenameParams,
  type Group,
  type GroupSlug,
  type Health,
  type NamedCommand,
  type NewProject,
  type Project,
  type ProjectId,
  type ProjectPatch,
  type ProjectWithState,
  type PtySession,
  type EnvSetParams,
  type EnvUseParams
} from "@matisa/core"
import {
  CommandsRepo,
  EnvRepo,
  GroupsRepo,
  ProjectsRepo,
  RuntimeRepo,
  type RuntimeSnapshot
} from "@matisa/store"
import { toEngineError } from "../../shared/error-map.js"
import { catalogChanged } from "../../shared/events.js"
import { EventsHub } from "../../server/server.events-hub.js"
import { PtyManager } from "../pty/pty.services.js"

// ────────────────────────────────────────────────────────────────────────────
// Catalog — the configuration domain. Project/env CRUD delegated to the Store
// repositories and a catalog_changed event emitted on every mutation. All
// faults surface as @matisa/core EngineError so the dispatcher stays uniform.
// POC: env values (secrets included) persist in the DB; the `secret` flag only
// masks listings. A keychain provider re-enters post-POC.
// ────────────────────────────────────────────────────────────────────────────

export interface CatalogShape {
  readonly add: (input: NewProject) => Effect.Effect<Project, EngineError>
  readonly list: () => Effect.Effect<ReadonlyArray<ProjectWithState>, EngineError>
  readonly update: (id: ProjectId, patch: ProjectPatch) => Effect.Effect<Project, EngineError>
  readonly remove: (id: ProjectId) => Effect.Effect<void, EngineError>
  readonly envSet: (params: EnvSetParams) => Effect.Effect<EnvContext, EngineError>
  readonly envList: () => Effect.Effect<ReadonlyArray<EnvContext>, EngineError>
  readonly envUse: (params: EnvUseParams) => Effect.Effect<ProjectWithState, EngineError>
  readonly envCreate: (params: EnvCreateParams) => Effect.Effect<EnvContext, EngineError>
  readonly envRename: (params: EnvRenameParams) => Effect.Effect<EnvContext, EngineError>
  readonly envRemove: (contextId: ContextId) => Effect.Effect<void, EngineError>
  readonly commandSet: (params: CommandSetParams) => Effect.Effect<NamedCommand, EngineError>
  readonly commandList: (id: ProjectId) => Effect.Effect<ReadonlyArray<NamedCommand>, EngineError>
  readonly commandRemove: (id: ProjectId, name: string) => Effect.Effect<void, EngineError>
  readonly commandRun: (params: CommandRunParams) => Effect.Effect<PtySession, EngineError>
  readonly groupSet: (group: Group) => Effect.Effect<Group, EngineError>
  readonly groupList: () => Effect.Effect<ReadonlyArray<Group>, EngineError>
  readonly groupRemove: (slug: GroupSlug) => Effect.Effect<void, EngineError>
}

export class Catalog extends Context.Tag("Catalog")<Catalog, CatalogShape>() {}

const withState = (project: Project, snapshot: Option.Option<RuntimeSnapshot>): ProjectWithState =>
  Option.match(snapshot, {
    onNone: () => ({ ...project, state: "idle" as const, pid: undefined }),
    onSome: (s) => ({ ...project, state: s.state, pid: s.pid, health: s.health as Health | undefined })
  })

const make = Effect.gen(function* () {
  const projects = yield* ProjectsRepo
  const env = yield* EnvRepo
  const runtime = yield* RuntimeRepo
  const events = yield* EventsHub
  const commands = yield* CommandsRepo
  const groupsRepo = yield* GroupsRepo
  const pty = yield* PtyManager

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
    env
      .set({
        contextId: params.contextId,
        var: { key: params.key, value: params.value, secret: params.secret ?? false }
      })
      .pipe(Effect.mapError(toEngineError))

  const envList: CatalogShape["envList"] = () => env.list().pipe(Effect.mapError(toEngineError))

  const envUse: CatalogShape["envUse"] = (params) =>
    Effect.gen(function* () {
      yield* env.useContext(params.projectId, params.contextId).pipe(Effect.mapError(toEngineError))
      const project = yield* projects.get(params.projectId).pipe(Effect.mapError(toEngineError))
      const snap = yield* runtime.getState(params.projectId).pipe(Effect.mapError(toEngineError))
      return withState(project, snap)
    })

  const envCreate: CatalogShape["envCreate"] = (params) =>
    env.createContext(params.name, params.description).pipe(Effect.mapError(toEngineError))

  const envRename: CatalogShape["envRename"] = (params) =>
    params.contextId === BASE_CONTEXT_ID
      ? Effect.fail(
          new ValidationError({ field: "name", message: "The base environment cannot be renamed" })
        )
      : env.renameContext(params.contextId, params.name).pipe(Effect.mapError(toEngineError))

  // Removing a context re-points every project that was using it, so each of
  // those projects is announced as changed — a client showing one of them is
  // otherwise left displaying an environment that no longer exists.
  const envRemove: CatalogShape["envRemove"] = (contextId) =>
    contextId === BASE_CONTEXT_ID
      ? Effect.fail(
          new ValidationError({
            field: "contextId",
            message: "The base environment cannot be deleted"
          })
        )
      : env.removeContext(contextId).pipe(
          Effect.mapError(toEngineError),
          Effect.tap((affected) =>
            Effect.forEach(affected, (id) => events.emit(catalogChanged(id, "updated")), {
              discard: true
            })
          ),
          Effect.asVoid
        )

  // —— named commands ——

  const commandSet: CatalogShape["commandSet"] = (params) =>
    Effect.gen(function* () {
      // Validate the project exists so orphan commands can't be created.
      yield* projects.get(params.projectId).pipe(Effect.mapError(toEngineError))
      return yield* commands
        .set({
          projectId: params.projectId,
          name: params.name,
          command: params.command,
          vars: params.vars
        })
        .pipe(Effect.mapError(toEngineError))
    })

  const commandList: CatalogShape["commandList"] = (id) =>
    commands.list(id).pipe(Effect.mapError(toEngineError))

  const commandRemove: CatalogShape["commandRemove"] = (id, name) =>
    commands.remove(id, name).pipe(Effect.mapError(toEngineError))

  const commandRun: CatalogShape["commandRun"] = (params) =>
    Effect.gen(function* () {
      const project = yield* projects.get(params.projectId).pipe(Effect.mapError(toEngineError))
      const named = yield* commands
        .get(params.projectId, params.name)
        .pipe(Effect.mapError(toEngineError))

      // Old-app parity: at most two concurrent commands per project.
      const prefix = `cmd:${params.projectId}:`
      const live = yield* pty.liveSessionCount(prefix)
      if (live >= 2) {
        return yield* Effect.fail(
          new ValidationError({
            message: `project ${project.name} already has ${live} commands running (max 2)`
          })
        )
      }

      // Env layer 4: the command's own vars, which are unconditional — they are
      // configured on the command, so every run of it gets them. openSession
      // layers them over the project's resolved env (layers 1–3).
      const extraEnv: Record<string, string> = {}
      for (const v of named.vars) extraEnv[v.key] = v.value

      const sessionId = SessionId.make(`${prefix}${params.name}:${Date.now() % 1_000_000}`)
      return yield* pty.openSession({
        project,
        sessionId,
        command: named.command,
        cols: params.cols,
        rows: params.rows,
        extraEnv
      })
    })

  // —— groups ——

  const groupSet: CatalogShape["groupSet"] = (group) =>
    groupsRepo.set(group).pipe(Effect.mapError(toEngineError))

  const groupList: CatalogShape["groupList"] = () =>
    groupsRepo.list().pipe(Effect.mapError(toEngineError))

  const groupRemove: CatalogShape["groupRemove"] = (slug) =>
    groupsRepo.remove(slug).pipe(Effect.mapError(toEngineError))

  return Catalog.of({
    add,
    list,
    update,
    remove,
    envSet,
    envList,
    envUse,
    envCreate,
    envRename,
    envRemove,
    commandSet,
    commandList,
    commandRemove,
    commandRun,
    groupSet,
    groupList,
    groupRemove
  })
})

export const CatalogLive = Layer.effect(Catalog, make)
