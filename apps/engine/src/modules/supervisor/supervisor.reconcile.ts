import { Effect } from "effect"
import { RuntimeRepo, type RuntimeSnapshot, type SpawnRecord } from "@matisa/store"

// ────────────────────────────────────────────────────────────────────────────
// Boot reconciliation. On a fresh engine start any project persisted as
// running/starting/stopping is stale (its child died with the previous process).
// We reap outstanding spawn rows and settle those projects to `idle` so state is
// coherent before the socket accepts clients. Wired as an acquire-time dependency
// of the socket layer (runs inside server.socket before listen).
// ────────────────────────────────────────────────────────────────────────────

export const reconcile: Effect.Effect<void, never, RuntimeRepo> = Effect.gen(function* () {
  const runtimeRepo = yield* RuntimeRepo

  const spawns = yield* runtimeRepo
    .liveSpawns()
    .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<SpawnRecord>)))
  yield* Effect.forEach(spawns, (s) => runtimeRepo.removeSpawn(s.id).pipe(Effect.ignore), {
    discard: true
  })

  const snaps = yield* runtimeRepo
    .all()
    .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<RuntimeSnapshot>)))
  yield* Effect.forEach(
    snaps,
    (s) =>
      s.state === "running" || s.state === "starting" || s.state === "stopping"
        ? runtimeRepo.setState(s.projectId, { state: "idle" }).pipe(Effect.ignore)
        : Effect.void,
    { discard: true }
  )

  yield* Effect.logInfo(
    `supervisor: reconciled ${snaps.length} runtime rows, reaped ${spawns.length} stale spawns`
  )
})
