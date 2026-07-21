import { Duration, Effect, Schedule } from "effect"
import { spawn } from "node:child_process"
import { connect } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// ────────────────────────────────────────────────────────────────────────────
// Engine spawner — backs `matisa engine start` and the global --ensure-engine.
// Spawns the engine DETACHED via `node --import tsx` (never the tsx CLI — its
// forked child intercepts signals and skips graceful teardown), then waits for
// the socket to accept. Monorepo layout resolution is POC-honest: an installed
// CLI will resolve a bundled engine entry instead.
// ────────────────────────────────────────────────────────────────────────────

const ENGINE_MAIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "engine", "src", "main.ts"
)

const socketAccepts = (socketPath: string): Effect.Effect<boolean> =>
  Effect.async<boolean>((resume) => {
    const sock = connect(socketPath)
    const done = (ok: boolean) => {
      sock.destroy()
      resume(Effect.succeed(ok))
    }
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
    sock.setTimeout(1_000, () => done(false))
  })

/** Spawn the engine detached and wait (≤15s) for its socket. True = reachable. */
export const spawnEngineAndWait = (socketPath: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      const child = spawn(process.execPath, ["--import", "tsx", ENGINE_MAIN], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MATISA_SOCK: socketPath }
      })
      child.unref()
    })
    return yield* socketAccepts(socketPath).pipe(
      Effect.flatMap((ok) => (ok ? Effect.succeed(true) : Effect.fail("waiting" as const))),
      Effect.retry(Schedule.spaced(Duration.millis(500)).pipe(Schedule.upTo(Duration.seconds(15)))),
      Effect.catchAll(() => Effect.succeed(false))
    )
  })
