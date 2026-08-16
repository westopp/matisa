import { Context, Effect, Layer, Option } from "effect"
import {
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
  type EnvUnsetParams,
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
import { catalogChanged, configChanged } from "../../shared/events.js"
import { EventsHub } from "../../server/server.events-hub.js"
import { PtyManager } from "../pty/pty.services.js"

// ────────────────────────────────────────────────────────────────────────────
// Catalog — the configuration domain. Project/env CRUD delegated to the Store
// repositories, and every mutation announced: catalog_changed when a project
// row moved, config_changed when it was a group, a context or a command set.
// Both matter because the CLI and the desktop are peers — an edit made in one
// is only visible in the other if the engine says it happened.
// All faults surface as @matisa/core EngineError so the dispatcher stays uniform.
// POC: env values (secrets included) persist in the DB; the `secret` flag only
// masks listings. A keychain provider re-enters post-POC.
// ────────────────────────────────────────────────────────────────────────────

export interface CatalogShape {
  readonly add: (input: NewProject) => Effect.Effect<Project, EngineError>
  readonly list: () => Effect.Effect<ReadonlyArray<ProjectWithState>, EngineError>
  readonly update: (id: ProjectId, patch: ProjectPatch) => Effect.Effect<Project, EngineError>
  readonly remove: (id: ProjectId) => Effect.Effect<void, EngineError>
  readonly envSet: (params: EnvSetParams) => Effect.Effect<EnvContext, EngineError>
  readonly envUnset: (params: EnvUnsetParams) => Effect.Effect<EnvContext, EngineError>
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
      .pipe(
        Effect.mapError(toEngineError),
        Effect.tap((c) => events.emit(configChanged("context", "updated", c.id)))
      )

  const envUnset: CatalogShape["envUnset"] = (params) =>
    env
      .unsetVar(params.contextId, params.key)
      .pipe(
        Effect.mapError(toEngineError),
        Effect.tap((c) => events.emit(configChanged("context", "updated", c.id)))
      )

  const envList: CatalogShape["envList"] = () => env.list().pipe(Effect.mapError(toEngineError))

  const envUse: CatalogShape["envUse"] = (params) =>
    Effect.gen(function* () {
      yield* env.useContext(params.projectId, params.contextId).pipe(Effect.mapError(toEngineError))
      const project = yield* projects.get(params.projectId).pipe(Effect.mapError(toEngineError))
      const snap = yield* runtime.getState(params.projectId).pipe(Effect.mapError(toEngineError))
      // The project ROW changed (activeContextId), so this is catalog_changed
      // rather than a config scope — a client re-reads the project, not the
      // context list, to see which environment it will spawn with next.
      yield* events.emit(catalogChanged(params.projectId, "updated"))
      return withState(project, snap)
    })

  const envCreate: CatalogShape["envCreate"] = (params) =>
    env
      .createContext(params.projectId, params.name, params.description)
      .pipe(
        Effect.mapError(toEngineError),
        Effect.tap((c) => events.emit(configChanged("context", "added", c.id)))
      )

  // The base guards live in the repo now rather than here: it is the only place
  // that knows which row is a base, and a check keyed off a reserved id could
  // only ever have protected one project's.
  const envRename: CatalogShape["envRename"] = (params) =>
    env
      .renameContext(params.contextId, params.name)
      .pipe(
        Effect.mapError(toEngineError),
        Effect.tap((c) => events.emit(configChanged("context", "updated", c.id)))
      )

  // Removing a context detaches the owning project if it was the active one, so
  // that project is announced as changed — a client showing it is otherwise left
  // displaying an environment that no longer exists. The context list itself is
  // a separate announcement: the project event says the row moved, and nothing
  // in it says the context is gone, so a client that heard only that would
  // re-read the project and still offer the deleted environment in its picker.
  const envRemove: CatalogShape["envRemove"] = (contextId) =>
    env.removeContext(contextId).pipe(
      Effect.mapError(toEngineError),
      Effect.tap((owner) => events.emit(catalogChanged(owner, "updated"))),
      Effect.tap(() => events.emit(configChanged("context", "removed", contextId))),
      Effect.asVoid
    )

  // —— named commands ——

  const commandSet: CatalogShape["commandSet"] = (params) =>
    Effect.gen(function* () {
      // Validate the project exists so orphan commands can't be created.
      yield* projects.get(params.projectId).pipe(Effect.mapError(toEngineError))
      const saved = yield* commands
        .set({
          projectId: params.projectId,
          name: params.name,
          command: params.command,
          vars: params.vars
        })
        .pipe(Effect.mapError(toEngineError))
      // Scoped to the project so a client refreshes the one command list it has
      // actually read, rather than every list it has ever cached.
      yield* events.emit(configChanged("commands", "updated", params.projectId))
      return saved
    })

  const commandList: CatalogShape["commandList"] = (id) =>
    commands.list(id).pipe(Effect.mapError(toEngineError))

  const commandRemove: CatalogShape["commandRemove"] = (id, name) =>
    commands.remove(id, name).pipe(
      Effect.mapError(toEngineError),
      Effect.tap(() => events.emit(configChanged("commands", "removed", id)))
    )

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

  // groups.set is an upsert, so "updated" covers a create too — a client reacts
  // by re-reading the list either way, and claiming "added" for a retitle would
  // be the only inaccurate thing in the stream.
  const groupSet: CatalogShape["groupSet"] = (group) =>
    groupsRepo.set(group).pipe(
      Effect.mapError(toEngineError),
      Effect.tap((g) => events.emit(configChanged("group", "updated", g.slug)))
    )

  const groupList: CatalogShape["groupList"] = () =>
    groupsRepo.list().pipe(Effect.mapError(toEngineError))

  const groupRemove: CatalogShape["groupRemove"] = (slug) =>
    groupsRepo.remove(slug).pipe(
      Effect.mapError(toEngineError),
      Effect.tap(() => events.emit(configChanged("group", "removed", slug)))
    )

  return Catalog.of({
    add,
    list,
    update,
    remove,
    envSet,
    envUnset,
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
