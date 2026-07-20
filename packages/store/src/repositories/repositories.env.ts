import { Context, Effect, Layer } from "effect"
import type Database from "better-sqlite3"
import { ContextId, type EnvContext, type EnvVar, type ProjectId } from "@matisa/core"
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
  readonly value: string | null
  readonly secret_ref: string | null
}

const readVars = (sqlite: Sqlite, ctxId: string): ReadonlyArray<EnvVar> => {
  const rows = sqlite
    .prepare("SELECT key, is_secret, value, secret_ref FROM env_vars WHERE context_id = ? ORDER BY key")
    .all(ctxId) as ReadonlyArray<VarRowRaw>
  return rows.map((r): EnvVar =>
    r.is_secret
      ? { kind: "secret", key: r.key, secretRef: r.secret_ref ?? "" }
      : { kind: "plain", key: r.key, value: r.value ?? "" }
  )
}

const readContext = (sqlite: Sqlite, c: CtxRowRaw): EnvContext => ({
  id: ContextId.make(c.id),
  name: c.name,
  description: c.description ?? undefined,
  vars: readVars(sqlite, c.id)
})

// The var to set. A `secret` var carries only its keychain `secretRef` — the
// plaintext value NEVER reaches the store (the engine stashes it in the
// keychain first). Modelling this as a core `EnvVar` union makes it impossible
// to persist a plaintext secret: SecretEnvVar has no `value` field.
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
}

export class EnvRepo extends Context.Tag("EnvRepo")<EnvRepo, EnvRepoShape>() {}

export const EnvRepoLive = Layer.effect(
  EnvRepo,
  Effect.gen(function* () {
    const { sqlite } = yield* Store

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
              "INSERT INTO env_vars (context_id, key, is_secret, value, secret_ref) VALUES (?,?,?,?,?) ON CONFLICT(context_id, key) DO UPDATE SET is_secret=excluded.is_secret, value=excluded.value, secret_ref=excluded.secret_ref"
            )
            .run(
              input.contextId,
              v.key,
              v.kind === "secret" ? 1 : 0,
              v.kind === "plain" ? v.value : null,
              v.kind === "secret" ? v.secretRef : null
            )
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

    return EnvRepo.of({ set, list, useContext })
  })
)
