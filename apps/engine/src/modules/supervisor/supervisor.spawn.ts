import { Effect, type Scope } from "effect"
import pty, { type IPty } from "node-pty"
import type { Project } from "@matisa/core"
import { RUN_PTY_COLS, RUN_PTY_ROWS } from "../../config/config.constants.js"
import { signalName } from "../pty/pty.session.js"
import { SpawnError } from "./supervisor.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// spawnChild — an Effect.acquireRelease over a node-pty child. The supervised
// process runs on a REAL pseudo-terminal (interactivity with the managed
// service is a core requirement): stdin is open, prompts can be answered via
// pty.input, programs detect a TTY (colors, unbuffered output). forkpty makes
// the child a session leader, so pgid == pid and release SIGTERMs the whole
// group (then SIGKILLs the leader) — Scope teardown guarantees no orphans.
// `awaitExit` resolves on the REAL reaped exit via onExit — never a
// kill(pid, 0) poll (state-is-truth).
// ────────────────────────────────────────────────────────────────────────────

export interface Child {
  readonly pty: IPty
  readonly pid: number
  readonly cols: number
  readonly rows: number
  readonly awaitExit: Effect.Effect<{ readonly code: number | null; readonly signal: string | null }>
}

export const spawnChild = (
  project: Project,
  env: Record<string, string>
): Effect.Effect<Child, SpawnError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        pty.spawn(project.command.program, [...project.command.args], {
          name: "xterm-256color",
          cols: RUN_PTY_COLS,
          rows: RUN_PTY_ROWS,
          cwd: project.command.cwd ?? project.root,
          env: { ...process.env, ...env } as Record<string, string>
        }),
      catch: (cause) => new SpawnError({ projectId: project.id, errorMessage: String(cause) })
    }),
    (child) =>
      Effect.sync(() => {
        try {
          // Session leader → pgid == pid; sweep the whole tree.
          process.kill(-child.pid, "SIGTERM")
        } catch {
          // group already gone
        }
        try {
          child.kill("SIGKILL")
        } catch {
          // already exited
        }
      })
  ).pipe(
    Effect.map((child) => {
      // Capture the exit EAGERLY: onExit fires once, and a child that dies
      // faster than the runner reaches `yield* awaitExit` must not be missed —
      // "spawned + no exit event ⇒ running" only holds if no exit can slip by.
      type ExitInfo = { readonly code: number | null; readonly signal: string | null }
      let exited: ExitInfo | null = null
      const waiters: Array<(info: ExitInfo) => void> = []
      child.onExit(({ exitCode, signal }) => {
        const info: ExitInfo = { code: signal ? null : exitCode, signal: signalName(signal) }
        exited = info
        for (const w of waiters.splice(0)) w(info)
      })
      return {
        pty: child,
        pid: child.pid,
        cols: RUN_PTY_COLS,
        rows: RUN_PTY_ROWS,
        awaitExit: Effect.async<ExitInfo>((resume) => {
          if (exited !== null) resume(Effect.succeed(exited))
          else waiters.push((info) => resume(Effect.succeed(info)))
        })
      }
    })
  )
