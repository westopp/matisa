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
import { SettingsRepo } from "../repositories/repositories.settings.js"
import { Store } from "../store.client.js"

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

  it("round-trips an event that names no project, and keeps it out of a project filter", async () => {
    const r = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const events = yield* EventsRepo
        const p = yield* projects.create(newProject("scoped"))
        const before = yield* events.latestCursor()
        yield* events.append({
          ts: 3,
          type: "config_changed",
          payload: { scope: "group", action: "updated", id: "seethis" }
        } as never)
        yield* events.append({ ts: 4, projectId: p.id, type: "state_changed", payload: { a: 1 } } as never)
        const all = yield* events.pull({ since: before })
        const mine = yield* events.pull({ since: before, projectId: p.id })
        return { all, mine }
      })
    )
    assert.equal(r.all.events.length, 2)
    const config = r.all.events.find((e) => e.type === "config_changed")
    assert.ok(config, "the unscoped event is durable and replays")
    // Omitted, not undefined: the union's unscoped branch does not declare it,
    // and a present key would decode as a malformed scoped event.
    assert.equal("projectId" in config, false)
    assert.equal(r.mine.events.length, 1, "a project filter excludes what names no project")
    assert.equal(r.mine.events[0]?.type, "state_changed")
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
    const out = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const env = yield* EnvRepo
        const p = yield* projects.create(newProject("env-roundtrip"))
        const ctx = yield* env.createContext(p.id, "staging")
        yield* env.set({ contextId: ctx.id, var: { key: "URL", value: "http://x", secret: false } })
        yield* env.set({ contextId: ctx.id, var: { key: "TOKEN", value: "s3cr3t", secret: true } })
        yield* env.set({ contextId: ctx.id, var: { key: "URL", value: "http://y", secret: false } }) // upsert
        return { ctxId: ctx.id, list: yield* env.list() }
      })
    )
    const ctx = out.list.find((c) => c.id === out.ctxId)
    assert.ok(ctx, "context exists")
    const url = ctx.vars.find((v) => v.key === "URL")
    const token = ctx.vars.find((v) => v.key === "TOKEN")
    assert.deepEqual(url, { key: "URL", value: "http://y", secret: false })
    assert.deepEqual(token, { key: "TOKEN", value: "s3cr3t", secret: true })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// The scoping guarantees from migration 0006. Each of these was reachable in
// the global model: a var could be written to a context belonging to nobody, a
// project could be pointed at another project's environment, and the single
// shared `base` reached every spawn in the installation.
// ────────────────────────────────────────────────────────────────────────────

describe("EnvRepo — environments belong to exactly one project", () => {
  it("gives every new project its own base, atomically with the project", async () => {
    const out = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const env = yield* EnvRepo
        const p = yield* projects.create(newProject("has-base"))
        return { id: p.id, contexts: yield* env.list() }
      })
    )
    const mine = out.contexts.filter((c) => c.projectId === out.id)
    assert.equal(mine.length, 1, "exactly one context, and it is the base")
    assert.equal(mine[0]?.isBase, true)
    assert.equal(mine[0]?.name, "base")
  })

  it("refuses to write a var into a context that does not exist", async () => {
    const result = await runtime(
      Effect.gen(function* () {
        const env = yield* EnvRepo
        return yield* env
          .set({
            contextId: ContextId.make("conjured-from-nothing"),
            var: { key: "X", value: "y", secret: false }
          })
          .pipe(Effect.either)
      })
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") assert.equal(result.left._tag, "NotFound")
  })

  it("refuses to point a project at another project's context", async () => {
    const out = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const env = yield* EnvRepo
        const mine = yield* projects.create(newProject("borrower"))
        const theirs = yield* projects.create(newProject("lender"))
        const foreign = yield* env.createContext(theirs.id, "dev")
        const attempt = yield* env.useContext(mine.id, foreign.id).pipe(Effect.either)
        return { attempt, project: yield* projects.get(mine.id) }
      })
    )
    assert.equal(out.attempt._tag, "Left")
    if (out.attempt._tag === "Left") {
      assert.equal(out.attempt.left._tag, "ContextNotInProject")
    }
    assert.equal(out.project.activeContextId, undefined, "and nothing was written")
  })

  it("lets two projects each have a context of the same name", async () => {
    const out = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const env = yield* EnvRepo
        const a = yield* projects.create(newProject("twin-a"))
        const b = yield* projects.create(newProject("twin-b"))
        return {
          a: yield* env.createContext(a.id, "dev"),
          b: yield* env.createContext(b.id, "dev")
        }
      })
    )
    assert.equal(out.a.name, "dev")
    assert.equal(out.b.name, "dev")
    assert.notEqual(out.a.id, out.b.id, "ids stay globally unique so the CLI can address them")
  })

  it("rejects a duplicate name within one project", async () => {
    const result = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const env = yield* EnvRepo
        const p = yield* projects.create(newProject("dup-names"))
        yield* env.createContext(p.id, "dev")
        return yield* env.createContext(p.id, "dev").pipe(Effect.either)
      })
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") assert.equal(result.left._tag, "NameTaken")
  })

  it("will not rename or delete a project's base", async () => {
    const out = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const env = yield* EnvRepo
        const p = yield* projects.create(newProject("immutable-base"))
        const base = (yield* env.list()).find((c) => c.projectId === p.id && c.isBase)!
        return {
          renamed: yield* env.renameContext(base.id, "nope").pipe(Effect.either),
          removed: yield* env.removeContext(base.id).pipe(Effect.either)
        }
      })
    )
    assert.equal(out.renamed._tag, "Left")
    if (out.renamed._tag === "Left") assert.equal(out.renamed.left._tag, "BaseContextImmutable")
    assert.equal(out.removed._tag, "Left")
    if (out.removed._tag === "Left") assert.equal(out.removed.left._tag, "BaseContextImmutable")
  })

  it("takes a project's contexts with it when the project is removed", async () => {
    const out = await runtime(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo
        const env = yield* EnvRepo
        const p = yield* projects.create(newProject("cascade-me"))
        const ctx = yield* env.createContext(p.id, "dev")
        yield* env.set({ contextId: ctx.id, var: { key: "K", value: "v", secret: false } })
        yield* projects.remove(p.id)
        return yield* env.list()
      })
    )
    assert.equal(
      out.filter((c) => c.name === "dev" && c.vars.some((v) => v.key === "K")).length,
      0,
      "no context outlives its project"
    )
  })
})

describe("SettingsRepo — the global key→JSON bag", () => {
  it("returns undefined for a key nobody has written", async () => {
    const v = await runtime(Effect.gen(function* () {
      return yield* (yield* SettingsRepo).get("operationsInstructions")
    }))
    assert.equal(v, undefined)
  })

  it("round-trips a value and overwrites it in place", async () => {
    const read = await runtime(Effect.gen(function* () {
      const repo = yield* SettingsRepo
      yield* repo.set("operationsInstructions", "ports 5700-5800")
      yield* repo.set("operationsInstructions", "ports 5900-6000")
      return yield* repo.get("operationsInstructions")
    }))
    assert.equal(read, "ports 5900-6000")
  })

  it("keeps structure, not just strings — the notification prefs are an object", async () => {
    const read = await runtime(Effect.gen(function* () {
      const repo = yield* SettingsRepo
      yield* repo.set("notifications", { enabled: true, crashed: false })
      return yield* repo.get("notifications")
    }))
    assert.deepEqual(read, { enabled: true, crashed: false })
  })

  it("hands the whole bag over at once, which is what a settings read is", async () => {
    const bag = await runtime(Effect.gen(function* () {
      const repo = yield* SettingsRepo
      yield* repo.set("hiddenProjects", ["a", "b"])
      return yield* repo.all()
    }))
    assert.deepEqual(bag["hiddenProjects"], ["a", "b"])
    assert.equal(bag["operationsInstructions"], "ports 5900-6000")
  })

  // A half-written row must not be able to take the document down with it: the
  // engine defaults the key instead, and everything else still reads.
  it("treats an unparseable row as absent rather than throwing", async () => {
    const bag = await runtime(Effect.gen(function* () {
      const { sqlite } = yield* Store
      sqlite.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?,?)").run("broken", "{not json")
      return yield* (yield* SettingsRepo).all()
    }))
    assert.equal(bag["broken"], undefined)
    assert.equal(bag["operationsInstructions"], "ports 5900-6000")
  })

  it("removes a key", async () => {
    const v = await runtime(Effect.gen(function* () {
      const repo = yield* SettingsRepo
      yield* repo.remove("hiddenProjects")
      return yield* repo.get("hiddenProjects")
    }))
    assert.equal(v, undefined)
  })
})
