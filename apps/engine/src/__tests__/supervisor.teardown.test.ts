import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Effect, Exit, Scope } from "effect"
import { ProjectId, type Project } from "@matisa/core"
import { STOP_TIMEOUT_MS } from "../config/config.constants.js"
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

/** Spawn under a scope, close the scope, and report how long teardown took. */
const spawnThenTeardown = async (
  p: Project
): Promise<{ pid: number; elapsedMs: number }> => {
  const scope = await Effect.runPromise(Scope.make())
  const child = await Effect.runPromise(
    spawnChild(p, {}).pipe(Effect.provideService(Scope.Scope, scope))
  )
  const pid = child.pid

  // Let the shell install its trap before anything is signalled.
  await new Promise((r) => setTimeout(r, 300))

  const startedAt = Date.now()
  await Effect.runPromise(Scope.close(scope, Exit.void))
  return { pid, elapsedMs: Date.now() - startedAt }
}

describe("spawnChild teardown — a stop always completes", () => {
  it("returns promptly when the child honours SIGTERM", async () => {
    const { pid, elapsedMs } = await spawnThenTeardown(
      project("bash", ["-c", "sleep 60"])
    )

    assert.ok(
      elapsedMs < STOP_TIMEOUT_MS,
      `graceful exit should not wait out the SIGKILL budget (took ${elapsedMs}ms)`
    )
    assert.equal(alive(pid), false, "child should be gone")
  })

  it("escalates to SIGKILL and still returns when the child ignores SIGTERM", async () => {
    // Traps TERM and does nothing with it — the shellbox case, minus the shell.
    const { pid, elapsedMs } = await spawnThenTeardown(
      project("bash", ["-c", 'trap "" TERM; while true; do sleep 1; done'])
    )

    // The whole point: this used to never return at all.
    assert.ok(
      elapsedMs >= STOP_TIMEOUT_MS,
      `the drain budget should be honoured before escalating (took ${elapsedMs}ms)`
    )
    assert.ok(
      elapsedMs < STOP_TIMEOUT_MS + 5_000,
      `teardown must not outlive the budget by more than the reap grace (took ${elapsedMs}ms)`
    )

    // SIGKILL cannot be trapped; give the OS a moment to finish reaping.
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(alive(pid), false, "child should have been SIGKILLed")
  })

  it("sweeps grandchildren with the group, not just the leader", async () => {
    const { pid } = await spawnThenTeardown(
      project("bash", ["-c", "sleep 120 & sleep 120"])
    )
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(alive(pid), false, "leader should be gone")
  })
})
