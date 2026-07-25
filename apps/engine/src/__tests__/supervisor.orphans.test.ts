import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { Effect } from "effect"
import { ProjectId } from "@matisa/core"
import type { SpawnRecord } from "@matisa/store"
import { parseEtime, reapOrphan } from "../modules/supervisor/supervisor.orphans.js"

// ────────────────────────────────────────────────────────────────────────────
// Boot orphan sweep. Two obligations that pull in opposite directions:
//
//   • kill what we left behind — an engine that died without teardown leaks
//     live children that keep holding ports and writing to disk
//   • kill NOTHING else — pids are recycled, and a remembered pid that now
//     belongs to someone else's process must never be signalled
//
// The age check is what separates the two, so it is what these test.
// ────────────────────────────────────────────────────────────────────────────

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const record = (pid: number, startedAt: number): SpawnRecord => ({
  id: 1,
  projectId: ProjectId.make("11111111-1111-4111-8111-111111111111"),
  pid,
  pgid: pid,
  startedAt
})

/** A detached process in its own group — the shape a supervised child leaves. */
const detachedSleeper = (): number => {
  const child = spawn("sleep", ["120"], { detached: true, stdio: "ignore" })
  child.unref()
  return child.pid!
}

// The age check is only as good as this parser: if it returns undefined the
// sweep declines to kill anything, which is safe but useless. It reads `etime`
// rather than `etimes` precisely because macOS has no `etimes` keyword — and
// that mistake failed CLOSED and silently, which is the worst way to be wrong.
describe("parseEtime — ps elapsed-time formats, both platforms", () => {
  it("reads MM:SS", () => {
    assert.equal(parseEtime("00:07"), 7)
    assert.equal(parseEtime("12:30"), 750)
  })

  it("reads HH:MM:SS", () => {
    assert.equal(parseEtime("01:00:00"), 3_600)
    assert.equal(parseEtime(" 25:10:05 "), 90_605)
  })

  it("reads DD-HH:MM:SS", () => {
    assert.equal(parseEtime("2-03:04:05"), 2 * 86_400 + 3 * 3_600 + 4 * 60 + 5)
  })

  it("returns undefined for anything it cannot read, so the sweep declines", () => {
    assert.equal(parseEtime(""), undefined)
    assert.equal(parseEtime("   "), undefined)
    assert.equal(parseEtime("42"), undefined)
    assert.equal(parseEtime("ps: etime: keyword not found"), undefined)
  })
})

describe("reapOrphan — kill our leftovers, never anyone else's", () => {
  it("kills a live process whose age matches the spawn record", async () => {
    const pid = detachedSleeper()
    await new Promise((r) => setTimeout(r, 200))

    const killed = await Effect.runPromise(reapOrphan(record(pid, Date.now())))

    assert.equal(killed, true, "should report the orphan as reaped")
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(alive(pid), false, "orphan should be gone")
  })

  it("leaves a recycled pid alone when the process is older than the record", async () => {
    const pid = detachedSleeper()
    await new Promise((r) => setTimeout(r, 200))

    // The record claims this pid was spawned an hour ago; the process has been
    // alive for a fraction of a second. Different process, same number.
    const killed = await Effect.runPromise(reapOrphan(record(pid, Date.now() - 60 * 60 * 1000)))

    assert.equal(killed, false, "must not claim a kill it did not make")
    assert.equal(alive(pid), true, "an unrelated process must survive the sweep")

    process.kill(pid, "SIGKILL")
  })

  it("reports nothing to do for a pid that is already gone", async () => {
    const pid = detachedSleeper()
    process.kill(pid, "SIGKILL")
    await new Promise((r) => setTimeout(r, 200))

    const killed = await Effect.runPromise(reapOrphan(record(pid, Date.now())))
    assert.equal(killed, false)
  })
})
