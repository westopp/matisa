import { Context, Effect, Layer, Option } from "effect"
import { and, eq, isNull } from "drizzle-orm"
import { ProjectId, SessionId, type RuntimeState } from "@matisa/core"
import { crashHistory } from "../db.schema/db.crashes.js"
import { runtimeState, type RuntimeStateRow } from "../db.schema/db.runtime.js"
import { spawns, type SpawnRow } from "../db.schema/db.spawns.js"
import { Store } from "../store.client.js"
import { StoreQueryError } from "../store.errors.js"

/** The last-known runtime view of a project (what a client snapshot reads). */
export interface RuntimeSnapshot {
  readonly projectId: ProjectId
  readonly state: RuntimeState
  readonly pid?: number
  readonly sessionId?: SessionId
  readonly exitCode?: number
  readonly health?: string
  readonly since: number
}

/** A supervisor transition to persist. `since` defaults to now. */
export interface RuntimePatch {
  readonly state: RuntimeState
  readonly pid?: number
  readonly sessionId?: SessionId
  readonly exitCode?: number
  readonly health?: string
  readonly since?: number
}

export interface SpawnInput {
  readonly projectId: ProjectId
  readonly pid: number
  readonly pgid?: number
  readonly logPath?: string
}

export interface SpawnRecord {
  readonly id: number
  readonly projectId: ProjectId
  readonly pid: number
  readonly pgid?: number
  readonly logPath?: string
  readonly startedAt: number
}

export interface CrashInput {
  readonly projectId: ProjectId
  readonly exitCode?: number
  readonly signal?: string
  readonly summary?: string
  readonly logTail?: string
}

const toSnapshot = (r: RuntimeStateRow): RuntimeSnapshot => ({
  projectId: ProjectId.make(r.projectId),
  state: r.state as RuntimeState,
  pid: r.pid ?? undefined,
  sessionId: r.sessionId ? SessionId.make(r.sessionId) : undefined,
  exitCode: r.exitCode ?? undefined,
  health: r.health ?? undefined,
  since: r.since
})

const toSpawn = (r: SpawnRow): SpawnRecord => ({
  id: r.id,
  projectId: ProjectId.make(r.projectId),
  pid: r.pid,
  pgid: r.pgid ?? undefined,
  logPath: r.logPath ?? undefined,
  startedAt: r.startedAt
})

// ────────────────────────────────────────────────────────────────────────────
// RuntimeRepo — the supervisor's persistence surface. runtime_state holds one
// row per project (state-is-truth: written on every FSM transition, never
// polled); spawns persists pids for boot reconciliation; crash_history is the
// durable failure log.
//
// Three tables, but they are independent — every query touches exactly one and
// nothing is joined or assembled — so this repo goes through the schema-aware
// Drizzle client and takes its row types from the schema ($inferSelect) rather
// than hand-synced interfaces.
// ────────────────────────────────────────────────────────────────────────────

export interface RuntimeRepoShape {
  readonly getState: (
    projectId: ProjectId
  ) => Effect.Effect<Option.Option<RuntimeSnapshot>, StoreQueryError>
  readonly setState: (
    projectId: ProjectId,
    patch: RuntimePatch
  ) => Effect.Effect<void, StoreQueryError>
  readonly all: () => Effect.Effect<ReadonlyArray<RuntimeSnapshot>, StoreQueryError>
  readonly recordSpawn: (input: SpawnInput) => Effect.Effect<number, StoreQueryError>
  readonly liveSpawns: (
    projectId?: ProjectId
  ) => Effect.Effect<ReadonlyArray<SpawnRecord>, StoreQueryError>
  /** Reap a spawn (mark exited with its real code) — never a kill(pid,0) poll. */
  readonly removeSpawn: (spawnId: number, exitCode?: number) => Effect.Effect<void, StoreQueryError>
  readonly recordCrash: (input: CrashInput) => Effect.Effect<void, StoreQueryError>
}

export class RuntimeRepo extends Context.Tag("RuntimeRepo")<RuntimeRepo, RuntimeRepoShape>() {}

export const RuntimeRepoLive = Layer.effect(
  RuntimeRepo,
  Effect.gen(function* () {
    const { db } = yield* Store

    const q = <A>(fn: () => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({ try: fn, catch: (cause) => new StoreQueryError({ cause }) })

    const getState: RuntimeRepoShape["getState"] = (projectId) =>
      q(() => {
        const r = db
          .select()
          .from(runtimeState)
          .where(eq(runtimeState.projectId, projectId))
          .get()
        return r ? Option.some(toSnapshot(r)) : Option.none<RuntimeSnapshot>()
      })

    const setState: RuntimeRepoShape["setState"] = (projectId, patch) =>
      q(() => {
        // Every nullable field is written explicitly as `?? null`, never left
        // undefined: an absent key would be omitted from the UPDATE SET clause
        // and silently retain the previous transition's pid/exitCode. The row
        // must describe the CURRENT state only (state-is-truth).
        const row = {
          state: patch.state,
          pid: patch.pid ?? null,
          sessionId: patch.sessionId ?? null,
          exitCode: patch.exitCode ?? null,
          health: patch.health ?? null,
          since: patch.since ?? Date.now()
        }
        db.insert(runtimeState)
          .values({ projectId, ...row })
          .onConflictDoUpdate({ target: runtimeState.projectId, set: row })
          .run()
      })

    const all: RuntimeRepoShape["all"] = () =>
      q(() => {
        const rows = db.select().from(runtimeState).orderBy(runtimeState.projectId).all()
        return rows.map(toSnapshot)
      })

    const recordSpawn: RuntimeRepoShape["recordSpawn"] = (input) =>
      q(() => {
        const row = db
          .insert(spawns)
          .values({
            projectId: input.projectId,
            pid: input.pid,
            pgid: input.pgid ?? null,
            logPath: input.logPath ?? null,
            startedAt: Date.now()
          })
          .returning({ id: spawns.id })
          .get()
        return row.id
      })

    const liveSpawns: RuntimeRepoShape["liveSpawns"] = (projectId) =>
      q(() => {
        const rows = db
          .select()
          .from(spawns)
          .where(
            and(
              isNull(spawns.exitedAt),
              projectId ? eq(spawns.projectId, projectId) : undefined
            )
          )
          .orderBy(spawns.startedAt)
          .all()
        return rows.map(toSpawn)
      })

    const removeSpawn: RuntimeRepoShape["removeSpawn"] = (spawnId, exitCode) =>
      q(() => {
        db.update(spawns)
          .set({ exitedAt: Date.now(), exitCode: exitCode ?? null })
          .where(eq(spawns.id, spawnId))
          .run()
      })

    const recordCrash: RuntimeRepoShape["recordCrash"] = (input) =>
      q(() => {
        db.insert(crashHistory)
          .values({
            projectId: input.projectId,
            ts: Date.now(),
            exitCode: input.exitCode ?? null,
            signal: input.signal ?? null,
            summary: input.summary ?? null,
            logTail: input.logTail ?? null
          })
          .run()
      })

    return RuntimeRepo.of({
      getState,
      setState,
      all,
      recordSpawn,
      liveSpawns,
      removeSpawn,
      recordCrash
    })
  })
)
