import { Context, Data, Effect, Layer } from "effect"
import type Database from "better-sqlite3"
import { BASE_CONTEXT_ID, ContextId, ProjectId, type EnvContext, type EnvVar } from "@matisa/core"
import { Store } from "../store.client.js"
import { NotFound, StoreQueryError } from "../store.errors.js"

type Sqlite = Database.Database

interface CtxRowRaw {
  readonly id: string
  readonly name: string
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
  name: c.name,
  description: c.description ?? undefined,
  vars: readVars(sqlite, c.id)
})

// The var to set. POC: `value` is stored for every var, secrets included;
// `secret` only drives masking in listings. Keychain-backed storage post-POC.
export interface EnvSetInput {
  readonly contextId: ContextId
  readonly name?: string
  readonly description?: string
  readonly var: EnvVar
}

export interface EnvRepoShape {
  /** Upsert a context and one of its vars; returns the full context. */
  readonly set: (input: EnvSetInput) => Effect.Effect<EnvContext, StoreQueryError>
  readonly list: () => Effect.Effect<ReadonlyArray<EnvContext>, StoreQueryError>
  /** Point a project at the context whose vars apply on (re)spawn. */
  readonly useContext: (
    projectId: ProjectId,
    contextId: ContextId
  ) => Effect.Effect<void, NotFound | StoreQueryError>
  /** Create an empty context. The id is derived from the name here, not by the
   *  caller — a client-chosen id could collide with the reserved `base`. */
  readonly createContext: (
    name: string,
    description?: string
  ) => Effect.Effect<EnvContext, NameTaken | StoreQueryError>
  readonly renameContext: (
    contextId: ContextId,
    name: string
  ) => Effect.Effect<EnvContext, NotFound | NameTaken | StoreQueryError>
  /** Drop a context, its vars (FK cascade), and any project pointing at it. */
  readonly removeContext: (
    contextId: ContextId
  ) => Effect.Effect<ReadonlyArray<ProjectId>, NotFound | StoreQueryError>
}

/** Context names are unique — the pills are how a human tells them apart, so two
 *  called "staging" would be indistinguishable. */
export class NameTaken extends Data.TaggedError("NameTaken")<{
  readonly entity: string
  readonly name: string
}> {}

/** Ids are slugs of the name: stable, readable in the DB, and collision-checked
 *  below. A name that slugs to nothing (emoji, CJK) still needs an id, hence the
 *  counter suffix rather than a bare slug. */
const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

export class EnvRepo extends Context.Tag("EnvRepo")<EnvRepo, EnvRepoShape>() {}

export const EnvRepoLive = Layer.effect(
  EnvRepo,
  Effect.gen(function* () {
    const { sqlite, transaction } = yield* Store

    const q = <A>(fn: () => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({ try: fn, catch: (cause) => new StoreQueryError({ cause }) })

    const set: EnvRepoShape["set"] = (input) =>
      Effect.gen(function* () {
        const v = input.var
        yield* q(() => {
          sqlite
            .prepare(
              "INSERT INTO env_contexts (id, name, description) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description"
            )
            .run(input.contextId, input.name ?? input.contextId, input.description ?? null)
          sqlite
            .prepare(
              "INSERT INTO env_vars (context_id, key, is_secret, value) VALUES (?,?,?,?) ON CONFLICT(context_id, key) DO UPDATE SET is_secret=excluded.is_secret, value=excluded.value"
            )
            .run(input.contextId, v.key, v.secret ? 1 : 0, v.value)
        })
        return yield* q(() => {
          const c = sqlite
            .prepare("SELECT id, name, description FROM env_contexts WHERE id = ?")
            .get(input.contextId) as CtxRowRaw
          return readContext(sqlite, c)
        })
      })

    const list: EnvRepoShape["list"] = () =>
      q(() => {
        const rows = sqlite
          .prepare("SELECT id, name, description FROM env_contexts ORDER BY name")
          .all() as ReadonlyArray<CtxRowRaw>
        return rows.map((c) => readContext(sqlite, c))
      })

    const useContext: EnvRepoShape["useContext"] = (projectId, contextId) =>
      Effect.gen(function* () {
        const ctx = yield* q(
          () =>
            sqlite.prepare("SELECT id FROM env_contexts WHERE id = ?").get(contextId) as
              | { id: string }
              | undefined
        )
        if (!ctx) return yield* Effect.fail(new NotFound({ entity: "env_context", id: contextId }))
        const proj = yield* q(
          () =>
            sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as
              | { id: string }
              | undefined
        )
        if (!proj) return yield* Effect.fail(new NotFound({ entity: "project", id: projectId }))
        yield* q(() => {
          sqlite
            .prepare("UPDATE projects SET active_context_id = ?, updated_at = ? WHERE id = ?")
            .run(contextId, Date.now(), projectId)
        })
      })

    const byName = (name: string, exceptId?: string): Effect.Effect<boolean, StoreQueryError> =>
      q(() => {
        const row = sqlite
          .prepare("SELECT id FROM env_contexts WHERE lower(name) = lower(?)")
          .get(name.trim()) as { id: string } | undefined
        return row !== undefined && row.id !== exceptId
      })

    const readById = (contextId: string): Effect.Effect<EnvContext | undefined, StoreQueryError> =>
      q(() => {
        const c = sqlite
          .prepare("SELECT id, name, description FROM env_contexts WHERE id = ?")
          .get(contextId) as CtxRowRaw | undefined
        return c === undefined ? undefined : readContext(sqlite, c)
      })

    const createContext: EnvRepoShape["createContext"] = (name, description) =>
      Effect.gen(function* () {
        const trimmed = name.trim()
        if (yield* byName(trimmed)) {
          return yield* Effect.fail(new NameTaken({ entity: "env_context", name: trimmed }))
        }
        // The slug may already be spoken for by a context whose name has since
        // changed, so probe for a free id rather than assuming slug === id.
        const id = yield* q(() => {
          const base = slugify(trimmed)
          const taken = (candidate: string): boolean =>
            sqlite.prepare("SELECT id FROM env_contexts WHERE id = ?").get(candidate) !== undefined
          if (base !== "" && base !== BASE_CONTEXT_ID && !taken(base)) return base
          const stem = base === "" ? "env" : base
          for (let n = 2; ; n += 1) {
            const candidate = `${stem}-${n}`
            if (!taken(candidate)) return candidate
          }
        })
        yield* q(() => {
          sqlite
            .prepare("INSERT INTO env_contexts (id, name, description) VALUES (?,?,?)")
            .run(id, trimmed, description ?? null)
        })
        return { id: ContextId.make(id), name: trimmed, description, vars: [] }
      })

    const renameContext: EnvRepoShape["renameContext"] = (contextId, name) =>
      Effect.gen(function* () {
        const trimmed = name.trim()
        const existing = yield* readById(contextId)
        if (existing === undefined) {
          return yield* Effect.fail(new NotFound({ entity: "env_context", id: contextId }))
        }
        if (yield* byName(trimmed, contextId)) {
          return yield* Effect.fail(new NameTaken({ entity: "env_context", name: trimmed }))
        }
        yield* q(() => {
          sqlite.prepare("UPDATE env_contexts SET name = ? WHERE id = ?").run(trimmed, contextId)
        })
        return { ...existing, name: trimmed }
      })

    const removeContext: EnvRepoShape["removeContext"] = (contextId) =>
      Effect.gen(function* () {
        const existing = yield* readById(contextId)
        if (existing === undefined) {
          return yield* Effect.fail(new NotFound({ entity: "env_context", id: contextId }))
        }
        // active_context_id carries no FK, so a delete would leave projects
        // pointing at a context that no longer exists. Detach them first, and
        // report who moved so the caller can tell those projects' watchers.
        const affected = yield* q(
          () =>
            sqlite
              .prepare("SELECT id FROM projects WHERE active_context_id = ?")
              .all(contextId) as ReadonlyArray<{ id: string }>
        )
        yield* transaction((s) => {
          s.prepare(
            "UPDATE projects SET active_context_id = NULL, updated_at = ? WHERE active_context_id = ?"
          ).run(Date.now(), contextId)
          s.prepare("DELETE FROM env_vars WHERE context_id = ?").run(contextId)
          s.prepare("DELETE FROM env_contexts WHERE id = ?").run(contextId)
        })
        return affected.map((r) => ProjectId.make(r.id))
      })

    return EnvRepo.of({ set, list, useContext, createContext, renameContext, removeContext })
  })
)
