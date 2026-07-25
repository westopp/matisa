import { Effect } from "effect"
import { dirname } from "node:path"
import type { Project } from "@matisa/core"
import { inlineRemove } from "../docker/docker.actions.js"
import { sh } from "../docker/docker.shell.js"

// ────────────────────────────────────────────────────────────────────────────
// Force-kill — the escape hatch behind `lifecycle.kill`.
//
// A graceful stop asks and then waits: SIGTERM, the app's own drain, and only
// then SIGKILL. That is the right default, and it is also what leaves a project
// wedged in `stopping` when the drain never finishes — the wait is the thing
// that hangs. This path removes the wait entirely. Nothing here signals TERM,
// nothing here has a grace period, and nothing here can block on a child that
// has decided not to leave.
//
// Unclean by construction: the process gets no chance to flush. That makes it a
// decision only the user can take, never one the engine takes on its own.
//
// Best-effort throughout — every failure is swallowed. A kill that could not
// find its target must still let the caller mark the project down, because the
// alternative is a project stuck in `stopping` forever, which is the exact
// condition this exists to end.
// ────────────────────────────────────────────────────────────────────────────

const DOCKER = "docker"

/** SIGKILL the whole group. forkpty makes the child a session leader, so
 *  pgid == pid and the negative pid sweeps grandchildren (`npm run dev` → the
 *  `vite` it spawned) rather than orphaning them. The single-pid fallback
 *  covers a child that is somehow not its own group leader. */
const killGroup = (pid: number): void => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone — the common case
    }
  }
}

/** Take `project` down by force. `pid` is the leader the runtime row remembers;
 *  it is only consulted for process projects, since a container's pid belongs
 *  to the daemon, not to us. */
export const hardKill = (project: Project, pid: number | undefined): Effect.Effect<void> => {
  if (project.kind === "docker") {
    // `rm -f` IS the kill: it SIGKILLs and removes in one call, so the next
    // start is not blocked by a dead container holding the name.
    return inlineRemove(project.name).pipe(Effect.ignoreLogged)
  }

  if (project.kind === "compose") {
    const file = project.composeFile
    if (file === undefined) return Effect.void
    const cwd = dirname(file)
    // `kill` stops every container dead; `down -t 0` then clears the network
    // and the container rows so the stack can come back up. The second call is
    // bounded and fast precisely because the first one already ended everything.
    return sh(DOCKER, ["compose", "-f", file, "kill"], { cwd, timeoutMs: 60_000 }).pipe(
      Effect.andThen(
        sh(DOCKER, ["compose", "-f", file, "down", "-t", "0"], { cwd, timeoutMs: 60_000 })
      ),
      Effect.ignoreLogged
    )
  }

  if (pid === undefined) return Effect.void
  return Effect.sync(() => killGroup(pid))
}
