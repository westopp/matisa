import { Duration, Effect, Schedule } from "effect"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { connect } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// ────────────────────────────────────────────────────────────────────────────
// Engine spawner — backs `matisa engine start` and the global --ensure-engine.
// Spawns the engine DETACHED, then waits for the socket to accept. A raced
// second engine exits itself on EADDRINUSE, so spawning against one that is
// already coming up is harmless.
//
// Entry resolution, in order:
//   1. MATISA_ENGINE_ENTRY — an explicit engine bundle, run as-is.
//   2. An engine.cjs sitting next to this file — the packaged layout, where
//      cli.cjs and engine.cjs ship side by side in the app's resources.
//   3. Monorepo dev layout — the TS source via `node --import tsx` (never the
//      tsx CLI: its forked child intercepts signals and skips graceful
//      teardown).
// All are LAZY: this module is CJS after bundling (no import.meta) and ESM
// under tsx (no __dirname), so each layout only touches the anchor it has.
// ────────────────────────────────────────────────────────────────────────────

const selfDir = (): string =>
  typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url))

const engineArgs = (): ReadonlyArray<string> => {
  const explicit = process.env.MATISA_ENGINE_ENTRY
  if (explicit !== undefined) return [explicit]
  const sibling = join(selfDir(), "engine.cjs")
  if (existsSync(sibling)) return [sibling]
  return ["--import", "tsx", join(selfDir(), "..", "..", "engine", "src", "main.ts")]
}

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
      const child = spawn(process.execPath, [...engineArgs()], {
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
