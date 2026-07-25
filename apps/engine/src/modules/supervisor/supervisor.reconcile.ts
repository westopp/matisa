import { Effect } from "effect"
import { RuntimeRepo, type RuntimeSnapshot, type SpawnRecord } from "@matisa/store"
import { reapOrphan } from "./supervisor.orphans.js"

// ────────────────────────────────────────────────────────────────────────────
// Boot reconciliation. On a fresh engine start any project persisted as
// running/starting/stopping is stale (its child died with the previous process)
// — EXCEPT that "died with" is an assumption the previous engine had to earn.
// If it was SIGKILLed, or exited before its finalizers ran, the children are
// still out there. So every outstanding spawn row is swept for a live process
// first (killed only when the pid provably still belongs to us), and only then
// dropped; the projects are settled to `idle` afterwards, so the state clients
// see is coherent AND true. Wired as an acquire-time dependency of the socket
// layer (runs inside server.socket before listen).
// ────────────────────────────────────────────────────────────────────────────

export const reconcile: Effect.Effect<void, never, RuntimeRepo> = Effect.gen(function* () {
  const runtimeRepo = yield* RuntimeRepo

  const spawns = yield* runtimeRepo
    .liveSpawns()
    .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<SpawnRecord>)))

  // Sequential, not concurrent: each sweep costs a `ps` and a 2s grace, and a
  // boot with a handful of orphans is not worth racing.
  let reaped = 0
  yield* Effect.forEach(
    spawns,
    (s) =>
      reapOrphan(s).pipe(
        Effect.tap((killed) => Effect.sync(() => (reaped += killed ? 1 : 0))),
        Effect.catchAllCause(() => Effect.void),
        Effect.andThen(runtimeRepo.removeSpawn(s.id).pipe(Effect.ignore))
      ),
    { discard: true }
  )

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
    `supervisor: reconciled ${snaps.length} runtime rows, cleared ${spawns.length} stale spawns (${reaped} orphaned process group${reaped === 1 ? "" : "s"} killed)`
  )
})
