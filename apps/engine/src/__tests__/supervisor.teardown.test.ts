import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Exit, Scope } from "effect"
import { ProjectId, type Project } from "@matisa/core"
import { REAP_GRACE_MS, STOP_TIMEOUT_MS } from "../config/config.constants.js"
import { spawnChild } from "../modules/supervisor/supervisor.spawn.js"

// ────────────────────────────────────────────────────────────────────────────
// Teardown must terminate. Always. Whatever the child does.
//
// The regression these cover: the escalation to SIGKILL used to be an
// `Effect.timeout` around the exit wait, inside the acquireRelease RELEASE.
// Release runs uninterruptibly during scope teardown, and a timeout fires by
// interrupting what it races — so it could never fire there. A child that
// ignores SIGTERM parked the finalizer forever, which parked the stop RPC,
// which left the project in `stopping` permanently and made a clean engine
// shutdown impossible (shutdown tears down these same scopes).
//
// A child that ignores SIGTERM is not exotic: every interactive shell does,
// `bash -i` included, and that is exactly what found this.
// ────────────────────────────────────────────────────────────────────────────

const project = (program: string, args: ReadonlyArray<string>): Project =>
  ({
    id: ProjectId.make("11111111-1111-4111-8111-111111111111"),
    name: "teardown-fixture",
    root: process.cwd(),
    kind: "process",
    command: { name: "teardown-fixture", program, args: [...args] },
    ports: [],
    createdAt: 0,
    updatedAt: 0
  }) as unknown as Project

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ── fixture readiness ───────────────────────────────────────────────────────
//
// Every fixture below has to reach a particular state before it is worth
// signalling — the trap installed, the grandchild forked — and each one says so
// by creating a sentinel file as its next statement. The helper waits for that
// file.
//
// It used to sleep a flat 300ms instead, which is a guess about how fast bash
// starts, and on a loaded machine the guess is wrong: the SIGTERM arrived
// before `trap` had run, the shell died gracefully in ~20ms, and the escalation
// test measured a graceful stop where it asserts a full 8s drain. Reproduced at
// roughly one run in eight with six concurrent copies of this file; every
// failure was a fixture that had not reached its trap. A sentinel cannot be
// early, so the race is gone rather than widened.

/** Generous, and not a timing assertion: nothing is measured against it. It
 *  only turns "the fixture never started" into a named failure instead of a
 *  hung test. */
const READY_TIMEOUT_MS = 15_000

const sentinelPath = (): string =>
  path.join(os.tmpdir(), `matisa-teardown-${randomUUID()}.ready`)

const awaitReady = async (file: string): Promise<void> => {
  const giveUpAt = Date.now() + READY_TIMEOUT_MS
  while (!fs.existsSync(file)) {
    if (Date.now() >= giveUpAt) {
      throw new Error(`fixture never signalled ready within ${READY_TIMEOUT_MS}ms (${file})`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Spawn under a scope, wait for the fixture to declare itself ready, close the
 *  scope, and report how long teardown took. */
const spawnThenTeardown = async (
  script: (ready: string) => string
): Promise<{ pid: number; elapsedMs: number }> => {
  const ready = sentinelPath()
  try {
    const scope = await Effect.runPromise(Scope.make())
    const child = await Effect.runPromise(
      spawnChild(project("bash", ["-c", script(ready)]), {}).pipe(
        Effect.provideService(Scope.Scope, scope)
      )
    )
    const pid = child.pid

    await awaitReady(ready)

    const startedAt = Date.now()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    return { pid, elapsedMs: Date.now() - startedAt }
  } finally {
    fs.rmSync(ready, { force: true })
  }
}

/** What teardown cannot exceed. The escalation path's own ceiling is the drain
 *  budget plus the reap grace — the backstop timer that gives up on a lost exit
 *  notification — and the rest is slack for timer scheduling on a busy machine.
 *  Derived from the constants rather than written as a number, so moving either
 *  one moves this with it. */
const TEARDOWN_CEILING_MS = STOP_TIMEOUT_MS + REAP_GRACE_MS + 3_000

describe("spawnChild teardown — a stop always completes", () => {
  it("returns promptly when the child honours SIGTERM", async () => {
    const { pid, elapsedMs } = await spawnThenTeardown((ready) => `: > "${ready}"; sleep 60`)

    assert.ok(
      elapsedMs < STOP_TIMEOUT_MS,
      `graceful exit should not wait out the SIGKILL budget (took ${elapsedMs}ms)`
    )
    assert.equal(alive(pid), false, "child should be gone")
  })

  it("escalates to SIGKILL and still returns when the child ignores SIGTERM", async () => {
    // Traps TERM and does nothing with it — the shellbox case, minus the shell.
    // The sentinel is written AFTER the trap, so reaching it proves the shell is
    // genuinely deaf to SIGTERM by the time the scope closes.
    const { pid, elapsedMs } = await spawnThenTeardown(
      (ready) => `trap "" TERM; : > "${ready}"; while true; do sleep 1; done`
    )

    // The whole point: this used to never return at all.
    assert.ok(
      elapsedMs >= STOP_TIMEOUT_MS,
      `the drain budget should be honoured before escalating (took ${elapsedMs}ms)`
    )
    assert.ok(
      elapsedMs < TEARDOWN_CEILING_MS,
      `teardown must not outlive the budget and its reap grace (took ${elapsedMs}ms)`
    )

    // SIGKILL cannot be trapped; give the OS a moment to finish reaping.
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(alive(pid), false, "child should have been SIGKILLed")
  })

  it("sweeps grandchildren with the group, not just the leader", async () => {
    // Sentinel after the fork, so "ready" means there really is a grandchild to
    // sweep — signalling earlier would have passed without testing anything.
    const { pid } = await spawnThenTeardown((ready) => `sleep 120 & : > "${ready}"; sleep 120`)
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(alive(pid), false, "leader should be gone")
  })
})
