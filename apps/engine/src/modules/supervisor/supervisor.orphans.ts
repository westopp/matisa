import { Duration, Effect } from "effect"
import { execFile } from "node:child_process"
import type { SpawnRecord } from "@matisa/store"
import { ORPHAN_PID_AGE_TOLERANCE_MS, ORPHAN_TERM_GRACE_MS } from "../../config/config.constants.js"

// ────────────────────────────────────────────────────────────────────────────
// Orphan reaping.
//
// A spawn row that outlived its engine means teardown never ran — the engine
// was SIGKILLed, or a finalizer wedged. Clearing the row alone (which is all
// boot reconciliation used to do) leaves the child running with nothing
// tracking it: it keeps holding its port, keeps writing to disk, and the next
// start either fails on the port or, for a portless worker, silently runs a
// second copy.
//
// Killing by remembered pid is only safe if the pid is still the SAME process.
// Pids are recycled, and an unlucky match would kill something innocent — so
// every candidate is age-checked first: the OS's own elapsed-time reading has
// to agree with the start time we recorded. When it does not, the row is
// dropped and the process is left alone. Refusing to kill is always the
// recoverable mistake.
// ────────────────────────────────────────────────────────────────────────────

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Parse `ps -o etime=`: `[[DD-]HH:]MM:SS`. Deliberately not `etimes` (plain
 *  seconds) — Linux has it, macOS does not, and a keyword error there would
 *  silently disable the whole sweep on the platform this runs on most. */
export const parseEtime = (raw: string): number | undefined => {
  const text = raw.trim()
  if (text.length === 0) return undefined

  const [days, clock] = text.includes("-") ? text.split("-") : [undefined, text]
  const parts = (clock ?? "").split(":").map(Number)
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return undefined

  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]]
  const dayPart = days === undefined ? 0 : Number(days)
  if (!Number.isFinite(dayPart)) return undefined

  return dayPart * 86_400 + (h ?? 0) * 3_600 + (m ?? 0) * 60 + (s ?? 0)
}

/** Seconds the process has been running, per the OS. `undefined` = no such pid
 *  (or `ps` could not answer, which is treated the same: do not kill). */
const elapsedSeconds = (pid: number): Effect.Effect<number | undefined> =>
  Effect.async<number | undefined>((resume) => {
    execFile("ps", ["-p", String(pid), "-o", "etime="], { timeout: 2_000 }, (err, stdout) => {
      resume(Effect.succeed(err ? undefined : parseEtime(stdout)))
    })
  })

/** Is this pid still the process we spawned, rather than a recycled number? */
const isSameProcess = (record: SpawnRecord): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const secs = yield* elapsedSeconds(record.pid)
    if (secs === undefined) return false
    const startedAt = Date.now() - secs * 1000
    return Math.abs(startedAt - record.startedAt) <= ORPHAN_PID_AGE_TOLERANCE_MS
  })

const signalGroup = (pgid: number, signal: "SIGTERM" | "SIGKILL"): void => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // group already gone
  }
}

/** Ask the group to leave, then insist. Same contract as a live stop, minus the
 *  drain budget: this process has already outlived the engine that owned it. */
export const reapOrphan = (record: SpawnRecord): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!alive(record.pid)) return false
    if (!(yield* isSameProcess(record))) {
      yield* Effect.logInfo(
        `orphan sweep: pid ${record.pid} is not our process any more (recycled) — leaving it alone`
      )
      return false
    }

    const pgid = record.pgid ?? record.pid
    signalGroup(pgid, "SIGTERM")
    yield* Effect.sleep(Duration.millis(ORPHAN_TERM_GRACE_MS))
    if (alive(record.pid)) signalGroup(pgid, "SIGKILL")

    yield* Effect.logWarning(
      `orphan sweep: killed leftover process group ${pgid} (project ${record.projectId}) from a previous engine`
    )
    return true
  })
