import { Context, Data, Effect, Layer } from "effect"
import type Database from "better-sqlite3"
import { ContextId, ProjectId, type EnvContext, type EnvVar } from "@matisa/core"
import { Store } from "../store.client.js"
import { NotFound, StoreQueryError } from "../store.errors.js"

type Sqlite = Database.Database

interface CtxRowRaw {
  readonly id: string
  readonly project_id: string
  readonly name: string
  readonly is_base: number
  readonly description: string | null
}

interface VarRowRaw {
  readonly key: string
  readonly is_secret: number
  readonly value: string
}

const readVars = (sqlite: Sqlite, ctxId: string): ReadonlyArray<EnvVar> => {
  const rows = sqlite
    .prepare("SELECT key, is_secret, value FROM env_vars WHERE context_id = ? ORDER BY key")
    .all(ctxId) as ReadonlyArray<VarRowRaw>
  return rows.map(
    (r): EnvVar => ({ key: r.key, value: r.value, secret: r.is_secret === 1 })
  )
}

const readContext = (sqlite: Sqlite, c: CtxRowRaw): EnvContext => ({
  id: ContextId.make(c.id),
  projectId: ProjectId.make(c.project_id),
  name: c.name,
  isBase: c.is_base === 1,
  description: c.description ?? undefined,
  vars: readVars(sqlite, c.id)
})

const CTX_COLUMNS = "id, project_id, name, is_base, description"

/** The var to set, in a context that must already exist. POC: `value` is stored
 *  for every var, secrets included; `secret` only drives masking in listings.
 *  Keychain-backed storage post-POC. */
export interface EnvSetInput {
  readonly contextId: ContextId
  readonly var: EnvVar
}

export interface EnvRepoShape {
  /** Upsert one var into an EXISTING context; returns the full context. Fails
   *  NotFound rather than creating the context, so a typo cannot conjure an
   *  environment that belongs to no project. */
  readonly set: (input: EnvSetInput) => Effect.Effect<EnvContext, NotFound | StoreQueryError>
  /** Delete one var from a context; returns the updated context. */
  readonly unsetVar: (
    contextId: ContextId,
    key: string
  ) => Effect.Effect<EnvContext, NotFound | StoreQueryError>
  /** Every context in the installation, each naming its project. Clients filter
   *  by projectId; the engine never resolves across projects. */
  readonly list: () => Effect.Effect<ReadonlyArray<EnvContext>, StoreQueryError>
  /** Point a project at one of ITS OWN contexts, applied on (re)spawn. */
  readonly useContext: (
    projectId: ProjectId,
    contextId: ContextId
  ) => Effect.Effect<void, NotFound | ContextNotInProject | StoreQueryError>
  /** Create an empty context for a project. The id is derived here, not by the
   *  caller — a client-chosen id could collide with another project's. */
  readonly createContext: (
    projectId: ProjectId,
    name: string,
    description?: string
  ) => Effect.Effect<EnvContext, NotFound | NameTaken | StoreQueryError>
  readonly renameContext: (
    contextId: ContextId,
    name: string
  ) => Effect.Effect<
    EnvContext,
    NotFound | NameTaken | BaseContextImmutable | StoreQueryError
  >
  /** Drop a context, its vars (FK cascade), and detach the project if it was
   *  the active one. Returns the owning project so callers can announce it. */
  readonly removeContext: (
    contextId: ContextId
  ) => Effect.Effect<ProjectId, NotFound | BaseContextImmutable | StoreQueryError>
}

/** Context names are unique WITHIN a project — the pills are how a human tells
 *  a project's environments apart, so two called "staging" on the same project
 *  would be indistinguishable. Across projects the name is free. */
export class NameTaken extends Data.TaggedError("NameTaken")<{
  readonly entity: string
  readonly name: string
}> {}

/** A project's base is created and destroyed with the project. Renaming it would
 *  leave the project without the layer everything else is defined relative to,
 *  and deleting it would leave its variables nowhere to live. */
export class BaseContextImmutable extends Data.TaggedError("BaseContextImmutable")<{
  readonly contextId: string
  readonly action: "rename" | "remove"
}> {}

/** An environment belongs to one project. Selecting another project's is how a
 *  project used to end up spawning with variables nobody expected it to have. */
export class ContextNotInProject extends Data.TaggedError("ContextNotInProject")<{
  readonly contextId: string
  readonly projectId: string
  readonly ownerId: string
}> {}

/** Ids are slugs: stable, readable in the DB, and readable as a CLI argument.
 *  They stay globally unique even though names are per-project, so `env set` can
 *  address a context with one argument — hence the project name in the stem, and
 *  the counter suffix for the case where that is still taken (a name that slugs
 *  to nothing, or a project renamed since). */
const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/** Probe for an unused context id built from `stem`. Exported because a
 *  project's base is created in ProjectsRepo's insert transaction — the base has
 *  to land atomically with the project, not in a second call that could fail and
 *  leave a project with no environment at all. */
export const freeContextId = (sqlite: Sqlite, projectName: string, name: string): string => {
  const taken = (candidate: string): boolean =>
    sqlite.prepare("SELECT id FROM env_contexts WHERE id = ?").get(candidate) !== undefined
  const stem = slugify(`${projectName}-${name}`) || "env"
  if (!taken(stem)) return stem
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}`
    if (!taken(candidate)) return candidate
  }
}

export class EnvRepo extends Context.Tag("EnvRepo")<EnvRepo, EnvRepoShape>() {}

export const EnvRepoLive = Layer.effect(
  EnvRepo,
  Effect.gen(function* () {
    const { sqlite, transaction } = yield* Store

    const q = <A>(fn: () => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({ try: fn, catch: (cause) => new StoreQueryError({ cause }) })

    const rowById = (contextId: string): Effect.Effect<CtxRowRaw | undefined, StoreQueryError> =>
      q(
        () =>
          sqlite.prepare(`SELECT ${CTX_COLUMNS} FROM env_contexts WHERE id = ?`).get(contextId) as
            | CtxRowRaw
            | undefined
      )

    const requireRow = (
      contextId: string
    ): Effect.Effect<CtxRowRaw, NotFound | StoreQueryError> =>
      Effect.gen(function* () {
        const c = yield* rowById(contextId)
        if (c === undefined) {
          return yield* Effect.fail(new NotFound({ entity: "env_context", id: contextId }))
        }
        return c
      })

    const set: EnvRepoShape["set"] = (input) =>
      Effect.gen(function* () {
        // The context has to exist first. This used to be an upsert on
        // env_contexts, which meant `env set <anything> KEY value` created a
        // context out of nothing — with project_id NOT NULL there is no row it
        // could honestly write, and inventing one is what produced unowned
        // environments in the first place.
        const row = yield* requireRow(input.contextId)
        const v = input.var
        yield* q(() => {
          sqlite
            .prepare(
              "INSERT INTO env_vars (context_id, key, is_secret, value) VALUES (?,?,?,?) ON CONFLICT(context_id, key) DO UPDATE SET is_secret=excluded.is_secret, value=excluded.value"
            )
            .run(input.contextId, v.key, v.secret ? 1 : 0, v.value)
        })
        return yield* q(() => readContext(sqlite, row))
      })

    const list: EnvRepoShape["list"] = () =>
      q(() => {
        const rows = sqlite
          .prepare(`SELECT ${CTX_COLUMNS} FROM env_contexts ORDER BY project_id, is_base DESC, name`)
          .all() as ReadonlyArray<CtxRowRaw>
        return rows.map((c) => readContext(sqlite, c))
      })

    const useContext: EnvRepoShape["useContext"] = (projectId, contextId) =>
      Effect.gen(function* () {
        const ctx = yield* requireRow(contextId)
        const proj = yield* q(
          () =>
            sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as
              | { id: string }
              | undefined
        )
        if (!proj) return yield* Effect.fail(new NotFound({ entity: "project", id: projectId }))
        // The guard the old global table could not express: a context is one
        // project's, and pointing another project at it would have that project
        // spawn with variables that were never written for it.
        if (ctx.project_id !== projectId) {
          return yield* Effect.fail(
            new ContextNotInProject({ contextId, projectId, ownerId: ctx.project_id })
          )
        }
        yield* q(() => {
          sqlite
            .prepare("UPDATE projects SET active_context_id = ?, updated_at = ? WHERE id = ?")
            .run(contextId, Date.now(), projectId)
        })
      })

    /** Name collision within one project only. */
    const nameTakenIn = (
      projectId: string,
      name: string,
      exceptId?: string
    ): Effect.Effect<boolean, StoreQueryError> =>
      q(() => {
        const row = sqlite
          .prepare("SELECT id FROM env_contexts WHERE project_id = ? AND lower(name) = lower(?)")
          .get(projectId, name.trim()) as { id: string } | undefined
        return row !== undefined && row.id !== exceptId
      })

    const createContext: EnvRepoShape["createContext"] = (projectId, name, description) =>
      Effect.gen(function* () {
        const project = yield* q(
          () =>
            sqlite.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as
              | { name: string }
              | undefined
        )
        if (!project) return yield* Effect.fail(new NotFound({ entity: "project", id: projectId }))
        const trimmed = name.trim()
        if (yield* nameTakenIn(projectId, trimmed)) {
          return yield* Effect.fail(new NameTaken({ entity: "env_context", name: trimmed }))
        }
        const id = yield* q(() => freeContextId(sqlite, project.name, trimmed))
        yield* q(() => {
          sqlite
            .prepare(
              "INSERT INTO env_contexts (id, project_id, name, is_base, description) VALUES (?,?,?,0,?)"
            )
            .run(id, projectId, trimmed, description ?? null)
        })
        return {
          id: ContextId.make(id),
          projectId,
          name: trimmed,
          isBase: false,
          description,
          vars: []
        }
      })

    const renameContext: EnvRepoShape["renameContext"] = (contextId, name) =>
      Effect.gen(function* () {
        const row = yield* requireRow(contextId)
        if (row.is_base === 1) {
          return yield* Effect.fail(new BaseContextImmutable({ contextId, action: "rename" }))
        }
        const trimmed = name.trim()
        if (yield* nameTakenIn(row.project_id, trimmed, contextId)) {
          return yield* Effect.fail(new NameTaken({ entity: "env_context", name: trimmed }))
        }
        yield* q(() => {
          sqlite.prepare("UPDATE env_contexts SET name = ? WHERE id = ?").run(trimmed, contextId)
        })
        return yield* q(() => readContext(sqlite, { ...row, name: trimmed }))
      })

    const unsetVar: EnvRepoShape["unsetVar"] = (contextId, key) =>
      Effect.gen(function* () {
        const row = yield* requireRow(contextId)
        yield* q(() => {
          sqlite.prepare("DELETE FROM env_vars WHERE context_id = ? AND key = ?").run(contextId, key)
        })
        return yield* q(() => readContext(sqlite, row))
      })

    const removeContext: EnvRepoShape["removeContext"] = (contextId) =>
      Effect.gen(function* () {
        const row = yield* requireRow(contextId)
        if (row.is_base === 1) {
          return yield* Effect.fail(new BaseContextImmutable({ contextId, action: "remove" }))
        }
        // active_context_id carries no FK, so a delete would leave the project
        // pointing at a context that no longer exists. Detach first. Only the
        // owning project can be pointed at it now, which is why this returns one
        // id where it used to return a list.
        yield* transaction((s) => {
          s.prepare(
            "UPDATE projects SET active_context_id = NULL, updated_at = ? WHERE active_context_id = ?"
          ).run(Date.now(), contextId)
          s.prepare("DELETE FROM env_vars WHERE context_id = ?").run(contextId)
          s.prepare("DELETE FROM env_contexts WHERE id = ?").run(contextId)
        })
        return ProjectId.make(row.project_id)
      })

    return EnvRepo.of({
      set,
      unsetVar,
      list,
      useContext,
      createContext,
      renameContext,
      removeContext
    })
  })
)
