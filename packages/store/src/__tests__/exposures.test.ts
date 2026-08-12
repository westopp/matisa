import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import type { NewProject } from "@matisa/core"
import { StoreLive } from "../store.index.js"
import { ExposuresRepo } from "../repositories/repositories.exposures.js"
import { ProjectsRepo } from "../repositories/repositories.projects.js"

// Pins the exposure-row semantics the exposure module leans on: upsert is
// idempotent per (project, kind), config_json round-trips (the allocated LAN
// port), and rows follow their project out via the FK cascade.

const dir = mkdtempSync(join(tmpdir(), "matisa-exposures-test-"))
process.env["MATISA_DB"] = join(dir, "test.db")

const rt = ManagedRuntime.make(StoreLive)
const runtime = <A, E>(
  eff: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Context<typeof rt>>
): Promise<A> => rt.runPromise(eff)

after(async () => {
  await rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const newProject = (name: string, port: number): NewProject =>
  ({
    name,
    root: "/tmp",
    kind: "process" as const,
    command: { name: "run", program: "sleep", args: ["1"] },
    ports: [{ number: port, protocol: "tcp" as const }]
  }) as NewProject

describe("ExposuresRepo", () => {
  it("upsert inserts then updates in place — one row per (project, kind)", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const exposures = yield* ExposuresRepo
        const p = yield* projects.create(newProject("expo-a", 6100))
        yield* exposures.upsert({ projectId: p.id, kind: "stable_url", enabled: true, hostname: "expo-a.localhost" })
        yield* exposures.upsert({ projectId: p.id, kind: "stable_url", enabled: true, hostname: "renamed.localhost" })
        return yield* exposures.forProject(p.id)
      })
    )
    assert.equal(r.length, 1)
    assert.equal(r[0]?.hostname, "renamed.localhost")
  })

  it("config_json round-trips the allocated LAN port", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const exposures = yield* ExposuresRepo
        const p = yield* projects.create(newProject("expo-b", 6101))
        yield* exposures.upsert({
          projectId: p.id,
          kind: "lan",
          enabled: true,
          hostname: "expo-b.matisa.local",
          config: { lanPort: 7801 }
        })
        return yield* exposures.forProject(p.id)
      })
    )
    assert.equal(r[0]?.config?.["lanPort"], 7801)
    assert.equal(r[0]?.enabled, true)
  })

  it("removeKind deletes only that kind; project delete cascades the rest", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const exposures = yield* ExposuresRepo
        const p = yield* projects.create(newProject("expo-c", 6102))
        yield* exposures.upsert({ projectId: p.id, kind: "stable_url", enabled: true })
        yield* exposures.upsert({ projectId: p.id, kind: "lan", enabled: true, config: { lanPort: 7802 } })
        yield* exposures.removeKind(p.id, "lan")
        const afterRemove = yield* exposures.forProject(p.id)
        yield* projects.remove(p.id)
        const afterCascade = yield* exposures.forProject(p.id)
        return { afterRemove, afterCascade }
      })
    )
    assert.deepEqual(r.afterRemove.map((x) => x.kind), ["stable_url"])
    assert.equal(r.afterCascade.length, 0)
  })
})
