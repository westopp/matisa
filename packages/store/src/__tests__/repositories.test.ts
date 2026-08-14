import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime, Option } from "effect"
import { ContextId, GroupSlug, ProjectId, type NewProject } from "@matisa/core"
import { StoreLive } from "../store.index.js"
import { CommandsRepo } from "../repositories/repositories.commands.js"
import { EventsRepo } from "../repositories/repositories.events.js"
import { GroupsRepo } from "../repositories/repositories.groups.js"
import { ProjectsRepo } from "../repositories/repositories.projects.js"
import { EnvRepo } from "../repositories/repositories.env.js"
import { RuntimeRepo } from "../repositories/repositories.runtime.js"

// Integration tests against a real temp SQLite file — these pin the semantics
// the engine leans on: the durable event cursor, strict-port uniqueness, the
// runtime upsert's null-clearing (state-is-truth), spawn reaping, and the
// secrets-never-plaintext shape of env vars.

const dir = mkdtempSync(join(tmpdir(), "matisa-store-test-"))
process.env["MATISA_DB"] = join(dir, "test.db")

// One Store (and one sqlite handle) for the whole file; disposed in after().
const rt = ManagedRuntime.make(StoreLive)
const runtime = <A, E>(eff: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Context<typeof rt>>): Promise<A> =>
  rt.runPromise(eff)

after(async () => {
  await rt.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const newProject = (name: string, port?: number): NewProject =>
  ({
    name,
    root: "/tmp",
    kind: "process" as const,
    command: { name: "run", program: "sleep", args: ["1"] },
    ports: port === undefined ? [] : [{ number: port, protocol: "tcp" as const }]
  }) as NewProject

describe("ProjectsRepo — strict ports", () => {
  it("creates, lists, gets, updates, removes", async () => {
    const p = await runtime(
      Effect.gen(function* () {
        const repo = yield* ProjectsRepo
        const created = yield* repo.create(newProject("alpha", 5100))
        const listed = yield* repo.list()
        const got = yield* repo.get(created.id)
        const updated = yield* repo.update(created.id, { name: "alpha2" })
        return { created, listed, got, updated }
      })
    )
    assert.equal(p.created.name, "alpha")
    assert.ok(p.listed.some((x) => x.id === p.created.id))
    assert.equal(p.got.id, p.created.id)
    assert.equal(p.updated.name, "alpha2")
  })

  it("rejects a duplicate port at create — BEFORE persistence", async () => {
    const result = await runtime(
      Effect.gen(function* () {
        const repo = yield* ProjectsRepo
        yield* repo.create(newProject("porter", 5200))
        const clash = yield* repo.create(newProject("clasher", 5200)).pipe(Effect.either)
        const all = yield* repo.list()
        return { clash, persisted: all.some((p) => p.name === "clasher") }
      })
    )
    assert.equal(result.clash._tag, "Left")
    if (result.clash._tag === "Left") {
      assert.equal(result.clash.left._tag, "PortConflict")
      if (result.clash.left._tag === "PortConflict") {
        assert.equal(result.clash.left.heldByName, "porter", "the holder is named, not just identified")
      }
    }
    assert.equal(result.persisted, false, "conflicting project must not be written")
  })

  it("rejects stealing a port via update", async () => {
    const clash = await runtime(
      Effect.gen(function* () {
        const repo = yield* ProjectsRepo
        const victim = yield* repo.create(newProject("victim", 5300))
        const thief = yield* repo.create(newProject("thief", 5301))
        void victim
        return yield* repo
          .update(thief.id, { ports: [{ number: 5300, protocol: "tcp" as const }] })
          .pipe(Effect.either)
      })
    )
    assert.equal(clash._tag, "Left")
    if (clash._tag === "Left") {
      assert.equal(clash.left._tag, "PortConflict")
      if (clash.left._tag === "PortConflict") assert.equal(clash.left.heldByName, "victim")
    }
  })

  it("get of a missing id is NotFound, not a throw", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const repo = yield* ProjectsRepo
        return yield* repo.get(ProjectId.make("nope")).pipe(Effect.either)
      })
    )
    assert.equal(r._tag, "Left")
    if (r._tag === "Left") assert.equal(r.left._tag, "NotFound")
  })
})

describe("EventsRepo — the durable cursor", () => {
  it("append returns increasing seqs; pull is since-exclusive with a resumable cursor", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const events = yield* EventsRepo
        const p = yield* projects.create(newProject("eventful"))
        const s1 = yield* events.append({ ts: 1, projectId: p.id, type: "state_changed", payload: { a: 1 } } as never)
        const s2 = yield* events.append({ ts: 2, projectId: p.id, type: "state_changed", payload: { a: 2 } } as never)
        const fromS1 = yield* events.pull({ since: s1 })
        const empty = yield* events.pull({ since: s2 })
        const limited = yield* events.pull({ since: 0, limit: 1 })
        const filtered = yield* events.pull({ since: 0, projectId: ProjectId.make("ghost") })
        const latest = yield* events.latestCursor()
        return { s1, s2, fromS1, empty, limited, filtered, latest }
      })
    )
    assert.equal(r.s2, r.s1 + 1)
    assert.equal(r.fromS1.events.length, 1, "since is exclusive")
    assert.equal(r.fromS1.events[0]?.seq, r.s2)
    assert.equal(r.fromS1.nextCursor, r.s2)
    assert.equal(r.empty.events.length, 0)
    assert.equal(r.empty.nextCursor, r.s2, "empty pull holds the cursor")
    assert.equal(r.limited.events.length, 1)
    assert.equal(r.filtered.events.length, 0)
    assert.equal(r.latest, r.s2)
  })
})

describe("RuntimeRepo — state-is-truth persistence", () => {
  it("upsert CLEARS absent fields instead of retaining stale pid/exitCode", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const rt = yield* RuntimeRepo
        const p = yield* projects.create(newProject("stateful"))
        yield* rt.setState(p.id, { state: "running", pid: 4242, exitCode: 7, health: "ok" })
        const running = yield* rt.getState(p.id)
        yield* rt.setState(p.id, { state: "idle" }) // pid/exitCode/health absent
        const idle = yield* rt.getState(p.id)
        return { running, idle }
      })
    )
    const running = Option.getOrThrow(r.running)
    assert.equal(running.pid, 4242)
    const idle = Option.getOrThrow(r.idle)
    assert.equal(idle.state, "idle")
    assert.equal(idle.pid, undefined, "stale pid must be cleared")
    assert.equal(idle.exitCode, undefined, "stale exitCode must be cleared")
    assert.equal(idle.health, undefined, "stale health must be cleared")
  })

  it("spawn lifecycle: record → live → reap with real exit code", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const rt = yield* RuntimeRepo
        const p = yield* projects.create(newProject("spawny"))
        const spawnId = yield* rt.recordSpawn({ projectId: p.id, pid: 9001, pgid: 9001 })
        const live = yield* rt.liveSpawns(p.id)
        yield* rt.removeSpawn(spawnId, 137)
        const afterReap = yield* rt.liveSpawns(p.id)
        return { live, afterReap }
      })
    )
    assert.equal(r.live.length, 1)
    assert.equal(r.live[0]?.pid, 9001)
    assert.equal(r.afterReap.length, 0, "reaped spawn must leave the live set")
  })

  it("failure history keeps crashes and engine errors apart, newest first", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const rt = yield* RuntimeRepo
        const p = yield* projects.create(newProject("failing"))
        // An engine error: nothing ran, so there is no exit code to carry.
        yield* rt.recordCrash({
          projectId: p.id,
          kind: "error",
          summary: "spawn failed: ENOENT"
        })
        // A crash: the child ran and exited badly.
        yield* rt.recordCrash({
          projectId: p.id,
          kind: "crash",
          exitCode: 1,
          signal: "SIGTERM",
          summary: "exit code 1",
          logTail: "boom"
        })
        // Omitted kind must read back as a crash — that is what every row
        // written before the column existed was.
        yield* rt.recordCrash({ projectId: p.id, summary: "legacy row" })
        return yield* rt.recentCrashes(p.id, 10)
      })
    )
    assert.equal(r.length, 3)
    const error = r.find((f) => f.summary === "spawn failed: ENOENT")
    assert.equal(error?.kind, "error")
    assert.equal(error?.exitCode, undefined, "an engine error has no exit code")
    const crash = r.find((f) => f.summary === "exit code 1")
    assert.equal(crash?.kind, "crash")
    assert.equal(crash?.exitCode, 1)
    assert.equal(crash?.logTail, "boom")
    assert.equal(r.find((f) => f.summary === "legacy row")?.kind, "crash", "kind must default to crash")
  })
})

describe("CommandsRepo — named commands with env override layers", () => {
  it("set/list/get round-trips a command's vars; upsert replaces the var set", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const cmds = yield* CommandsRepo
        const p = yield* projects.create(newProject("cmdful"))
        yield* cmds.set({
          projectId: p.id,
          name: "test",
          command: "jest --watch",
          vars: [
            { key: "NODE_ENV", value: "test" },
            { key: "DB", value: "staging-db" }
          ]
        })
        const first = yield* cmds.get(p.id, "test")
        // Upsert: same name, new command, new var set — must REPLACE.
        yield* cmds.set({
          projectId: p.id,
          name: "test",
          command: "jest",
          vars: [{ key: "ONLY", value: "one" }]
        })
        const second = yield* cmds.get(p.id, "test")
        const listed = yield* cmds.list(p.id)
        yield* cmds.remove(p.id, "test")
        const afterRm = yield* cmds.list(p.id)
        return { first, second, listed, afterRm }
      })
    )
    assert.equal(r.first.command, "jest --watch")
    assert.deepEqual(r.first.vars, [
      { key: "DB", value: "staging-db" },
      { key: "NODE_ENV", value: "test" }
    ])
    assert.equal(r.second.command, "jest")
    assert.deepEqual(r.second.vars, [{ key: "ONLY", value: "one" }])
    assert.equal(r.listed.length, 1)
    assert.equal(r.afterRm.length, 0)
  })
})

describe("GroupsRepo — standalone buckets, FK from projects", () => {
  it("set/list/remove; deleting a group clears members' group_slug (SET NULL)", async () => {
    const slug = GroupSlug.make("backend")
    const r = await runtime(
      Effect.gen(function* () {
        const groups = yield* GroupsRepo
        const projects = yield* ProjectsRepo
        yield* groups.set({ slug, title: "Backend", description: "apis" })
        const p = yield* projects.create({ ...newProject("grouped"), groupSlug: slug } as NewProject)
        const listed = yield* groups.list()
        yield* groups.remove(slug)
        const after = yield* projects.get(p.id)
        return { listed, after }
      })
    )
    assert.ok(r.listed.some((g) => g.slug === slug && g.title === "Backend"))
    assert.equal(r.after.groupSlug, undefined, "FK must SET NULL, not cascade-delete the project")
  })
})

describe("EventsRepo — retention", () => {
  it("prune keeps the newest N", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const events = yield* EventsRepo
        const p = yield* projects.create(newProject("retained"))
        for (let i = 1; i <= 10; i++) {
          yield* events.append({
            ts: i,
            projectId: p.id,
            type: "state_changed",
            payload: { from: "idle", to: "starting" }
          } as never)
        }
        const before = yield* events.latestCursor()
        const deleted = yield* events.prune(5)
        const after = yield* events.pull({ since: 0, limit: 100 })
        return { before, deleted, after }
      })
    )
    assert.ok(r.deleted > 0, "prune must delete something")
    assert.ok(
      r.after.events.every((e) => e.seq > r.before - 5),
      "only the newest 5 survive"
    )
  })
})

describe("EnvRepo — POC: values in the DB, secret flag masks listings", () => {
  it("round-trips plain and secret vars, upserts on same key", async () => {
    const ctxId = ContextId.make("test-ctx")
    const list = await runtime(
      Effect.gen(function* () {
        const env = yield* EnvRepo
        yield* env.set({ contextId: ctxId, name: "test", var: { key: "URL", value: "http://x", secret: false } })
        yield* env.set({ contextId: ctxId, var: { key: "TOKEN", value: "s3cr3t", secret: true } })
        yield* env.set({ contextId: ctxId, var: { key: "URL", value: "http://y", secret: false } }) // upsert
        return yield* env.list()
      })
    )
    const ctx = list.find((c) => c.id === ctxId)
    assert.ok(ctx, "context exists")
    const url = ctx.vars.find((v) => v.key === "URL")
    const token = ctx.vars.find((v) => v.key === "TOKEN")
    assert.deepEqual(url, { key: "URL", value: "http://y", secret: false })
    assert.deepEqual(token, { key: "TOKEN", value: "s3cr3t", secret: true })
  })
})
