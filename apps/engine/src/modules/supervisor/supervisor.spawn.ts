import { Effect, type Scope } from "effect"
import pty, { type IPty } from "node-pty"
import type { Project } from "@matisa/core"
import {
  REAP_GRACE_MS,
  RUN_PTY_COLS,
  RUN_PTY_ROWS,
  STOP_TIMEOUT_MS
} from "../../config/config.constants.js"
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
//
// The escalation is driven by NODE TIMERS, not by Effect combinators, and this
// is load-bearing. Release runs during scope teardown, which Effect executes
// uninterruptibly; `Effect.timeout` fires by interrupting what it races, so in
// here it can never fire at all. It once wrapped this wait, and a child that
// ignores SIGTERM (`bash -i`, any interactive shell) parked the finalizer
// forever: the stop RPC never returned, the project sat in `stopping` for good,
// and — because engine shutdown tears down these same scopes — the engine could
// no longer exit cleanly either. A setTimeout owes nothing to interrupt status,
// so the SIGKILL always lands, and a second timer bounds the wait even if the
// exit notification itself is lost. Nothing here can block indefinitely.
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
  /** Callback-level exit subscription — what teardown waits on, since it cannot
   *  use Effect's interrupt-driven combinators. Returns an unsubscribe. */
  readonly onExit: (cb: () => void) => () => void
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

/** Ask, wait, then insist — and always return. The wait gives the child a
 *  chance to run its SIGTERM handler; the timers guarantee that a child which
 *  never intended to honour it cannot hold teardown hostage. */
const gracefulStop = (handle: Handle): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    const pid = handle.child.pid
    if (handle.hasExited()) {
      resume(Effect.void)
      return
    }

    let settled = false
    const finish = (warning?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(escalation)
      clearTimeout(deadline)
      unsubscribe()
      resume(warning === undefined ? Effect.void : Effect.logWarning(warning))
    }

    const unsubscribe = handle.onExit(() => finish())

    signalGroup(pid, "SIGTERM")

    // Ignored SIGTERM, or a drain that outlived its budget. Escalate — SIGKILL
    // cannot be caught, blocked, or ignored, so this always ends the process.
    const escalation = setTimeout(() => {
      signalGroup(pid, "SIGKILL")
      try {
        handle.child.kill("SIGKILL")
      } catch {
        // exited between the timer firing and here
      }
    }, STOP_TIMEOUT_MS)

    // Backstop for the backstop: the process is gone by now, so if no exit has
    // been reported the notification was lost. Stop waiting on it.
    const deadline = setTimeout(
      () =>
        finish(
          `child ${pid} ignored SIGTERM and reported no exit ${REAP_GRACE_MS / 1000}s after SIGKILL — abandoning the wait`
        ),
      STOP_TIMEOUT_MS + REAP_GRACE_MS
    )

    return Effect.sync(() => {
      clearTimeout(escalation)
      clearTimeout(deadline)
      unsubscribe()
    })
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
        const waiters = new Set<(info: ExitInfo) => void>()
        child.onExit(({ exitCode, signal }) => {
          const info: ExitInfo = { code: signal ? null : exitCode, signal: signalName(signal) }
          exited = info
          for (const w of [...waiters]) {
            waiters.delete(w)
            w(info)
          }
        })

        const subscribe = (cb: (info: ExitInfo) => void): (() => void) => {
          // Never call back synchronously: a subscriber that unsubscribes in its
          // own callback would touch bindings that are not initialised yet.
          if (exited !== null) {
            const info = exited
            queueMicrotask(() => cb(info))
            return () => {}
          }
          waiters.add(cb)
          return () => waiters.delete(cb)
        }

        return {
          child,
          hasExited: () => exited !== null,
          onExit: (cb) => subscribe(() => cb()),
          awaitExit: Effect.async<ExitInfo>((resume) => {
            const off = subscribe((info) => resume(Effect.succeed(info)))
            return Effect.sync(off)
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
