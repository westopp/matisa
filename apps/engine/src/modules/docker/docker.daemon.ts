import { Context, Duration, Effect, Layer, Schedule, SynchronizedRef } from "effect"
import type { DaemonStatusResult, DockerDaemonState } from "@matisa/core"
import { daemonRunning } from "./docker.actions.js"
import { sh } from "./docker.shell.js"

// ────────────────────────────────────────────────────────────────────────────
// DockerDaemon — engine-owned Docker Desktop lifecycle FSM (port of the old
// DockerDaemonService):
//   stopped/unknown/start_failed → start() → starting → (poll ready) → running
//   starting —(60s timeout)→ start_failed
// The engine NEVER starts Docker unprompted: `start` runs only when a client
// calls docker.daemon.start (the prompt-then-replay flow). Concurrent starts
// coalesce — a second start() while `starting` just reports the state.
// ────────────────────────────────────────────────────────────────────────────

const READY_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 1_000

export interface DockerDaemonShape {
  readonly status: () => Effect.Effect<DaemonStatusResult>
  readonly start: () => Effect.Effect<DaemonStatusResult>
  readonly stop: () => Effect.Effect<DaemonStatusResult>
  /** The cheap probe the supervisor's gating uses (no state mutation). */
  readonly probe: () => Effect.Effect<boolean>
}

export class DockerDaemon extends Context.Tag("DockerDaemon")<DockerDaemon, DockerDaemonShape>() {}

const make = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make<{ s: DockerDaemonState; message?: string }>({
    s: "unknown"
  })

  const report = (): Effect.Effect<DaemonStatusResult> =>
    SynchronizedRef.get(state).pipe(Effect.map(({ s, message }) => ({ state: s, message })))

  const status: DockerDaemonShape["status"] = () =>
    Effect.gen(function* () {
      const cur = yield* SynchronizedRef.get(state)
      // `starting` is authoritative while the poll runs; otherwise re-probe.
      if (cur.s === "starting") return { state: cur.s, message: cur.message }
      const up = yield* daemonRunning()
      const next: DockerDaemonState = up ? "running" : cur.s === "start_failed" ? "start_failed" : "stopped"
      yield* SynchronizedRef.set(state, { s: next, message: cur.message })
      return { state: next, message: cur.message }
    })

  const awaitReady = Effect.gen(function* () {
    const ok = yield* daemonRunning().pipe(
      Effect.flatMap((up) => (up ? Effect.succeed(true) : Effect.fail("not-yet" as const))),
      Effect.retry(
        Schedule.spaced(Duration.millis(POLL_INTERVAL_MS)).pipe(
          Schedule.upTo(Duration.millis(READY_TIMEOUT_MS))
        )
      ),
      Effect.catchAll(() => Effect.succeed(false))
    )
    yield* SynchronizedRef.set(
      state,
      ok
        ? { s: "running" }
        : { s: "start_failed", message: `Docker didn't come up within ${READY_TIMEOUT_MS / 1000}s` }
    )
  })

  const start: DockerDaemonShape["start"] = () =>
    Effect.gen(function* () {
      // Atomic guard: exactly one caller flips to `starting` and forks the
      // readiness poll; concurrent starts coalesce into a status report.
      const begin = yield* SynchronizedRef.modify(state, (cur) =>
        cur.s === "starting" || cur.s === "running"
          ? ([false, cur] as const)
          : ([true, { s: "starting" as const }] as const)
      )
      if (begin) {
        yield* sh("/usr/bin/open", ["-a", "Docker"], { timeoutMs: 10_000 }).pipe(Effect.ignore)
        yield* Effect.forkDaemon(awaitReady)
      }
      return yield* report()
    })

  const stop: DockerDaemonShape["stop"] = () =>
    Effect.gen(function* () {
      yield* sh("/usr/bin/osascript", ["-e", 'quit app "Docker"'], { timeoutMs: 10_000 }).pipe(
        Effect.ignore
      )
      yield* SynchronizedRef.set(state, { s: "stopped" })
      return yield* report()
    })

  return DockerDaemon.of({ status, start, stop, probe: () => daemonRunning() })
})

export const DockerDaemonLive = Layer.effect(DockerDaemon, make)
