import { Duration, Effect, Option, type Scope } from "effect"
import pty, { type IPty } from "node-pty"
import type { Project } from "@matisa/core"
import { RUN_PTY_COLS, RUN_PTY_ROWS, STOP_TIMEOUT_MS } from "../../config/config.constants.js"
import { signalName } from "../pty/pty.session.js"
import { SpawnError } from "./supervisor.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// spawnChild — an Effect.acquireRelease over a node-pty child. The supervised
// process runs on a REAL pseudo-terminal (interactivity with the managed
// service is a core requirement): stdin is open, prompts can be answered via
// pty.input, programs detect a TTY (colors, unbuffered output). forkpty makes
// the child a session leader, so pgid == pid and release SIGTERMs the whole
// group — Scope teardown guarantees no orphans.
// `awaitExit` resolves on the REAL reaped exit via onExit — never a
// kill(pid, 0) poll (state-is-truth).
//
// Teardown is GRACEFUL: SIGTERM the group, then wait up to STOP_TIMEOUT_MS for
// a real reaped exit before escalating to SIGKILL. Sending both back to back
// (as this once did) means the child never runs its SIGTERM handler — no
// connection drain, no flush, no cleanup — and makes every stop look
// instantaneous because nothing is ever waited on. The wait is the honest
// duration of a stop, and it is what the client renders as "Stopping…".
// ────────────────────────────────────────────────────────────────────────────

export interface Child {
  readonly pty: IPty
  readonly pid: number
  readonly cols: number
  readonly rows: number
  readonly awaitExit: Effect.Effect<{ readonly code: number | null; readonly signal: string | null }>
}

interface ExitInfo {
  readonly code: number | null
  readonly signal: string | null
}

interface Handle {
  readonly child: IPty
  /** Resolves on the REAL reaped exit. */
  readonly awaitExit: Effect.Effect<ExitInfo>
  readonly hasExited: () => boolean
}

/** Signal the whole process group, tolerating a group that is already gone. */
const signalGroup = (pid: number, signal: "SIGTERM" | "SIGKILL"): void => {
  try {
    // forkpty makes the child a session leader, so pgid == pid — this sweeps
    // grandchildren (the `npm run dev` → `vite` case) rather than orphaning them.
    process.kill(-pid, signal)
  } catch {
    // group already fully gone — the common case
  }
}

/** Ask, wait, then insist. The wait is what gives the child a chance to run its
 *  SIGTERM handler; without it a graceful shutdown is impossible by construction. */
const gracefulStop = (handle: Handle): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (handle.hasExited()) return

    signalGroup(handle.child.pid, "SIGTERM")

    const drained = yield* handle.awaitExit.pipe(
      Effect.timeout(Duration.millis(STOP_TIMEOUT_MS)),
      Effect.option
    )
    if (Option.isSome(drained)) return

    // Ignored SIGTERM, or a drain that outlived its budget. Escalate.
    yield* Effect.logWarning(
      `child ${handle.child.pid} did not exit within ${STOP_TIMEOUT_MS / 1000}s of SIGTERM — sending SIGKILL`
    )
    signalGroup(handle.child.pid, "SIGKILL")
    try {
      handle.child.kill("SIGKILL")
    } catch {
      // already exited between the check and here
    }
  })

export const spawnChild = (
  project: Project,
  env: Record<string, string>
): Effect.Effect<Child, SpawnError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: (): Handle => {
        const cmd = project.command
        if (cmd === undefined) {
          // Schema enforces command for kind=process; this guards the runner
          // being called with the wrong kind.
          throw new Error(`project ${project.name} (kind=${project.kind}) has no spawn command`)
        }
        const child = pty.spawn(cmd.program, [...cmd.args], {
          name: "xterm-256color",
          cols: RUN_PTY_COLS,
          rows: RUN_PTY_ROWS,
          cwd: cmd.cwd ?? project.root,
          env: { ...process.env, ...env } as Record<string, string>
        })

        // Capture the exit EAGERLY, here rather than downstream: onExit fires
        // once, and a child that dies faster than the runner reaches
        // `yield* awaitExit` must not be missed — "spawned + no exit event ⇒
        // running" only holds if no exit can slip by. The release path depends
        // on this too, since it awaits the same signal.
        let exited: ExitInfo | null = null
        const waiters: Array<(info: ExitInfo) => void> = []
        child.onExit(({ exitCode, signal }) => {
          const info: ExitInfo = { code: signal ? null : exitCode, signal: signalName(signal) }
          exited = info
          for (const w of waiters.splice(0)) w(info)
        })

        return {
          child,
          hasExited: () => exited !== null,
          awaitExit: Effect.async<ExitInfo>((resume) => {
            if (exited !== null) resume(Effect.succeed(exited))
            else waiters.push((info) => resume(Effect.succeed(info)))
          })
        }
      },
      catch: (cause) => new SpawnError({ projectId: project.id, errorMessage: String(cause) })
    }),
    gracefulStop
  ).pipe(
    Effect.map((handle) => ({
      pty: handle.child,
      pid: handle.child.pid,
      cols: RUN_PTY_COLS,
      rows: RUN_PTY_ROWS,
      awaitExit: handle.awaitExit
    }))
  )
