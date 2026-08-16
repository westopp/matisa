import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { ContextId, ProjectId, type EnvContext, type Project } from "@matisa/core"
import type { EnvRepoShape } from "@matisa/store"
import { resolveEnv } from "../modules/catalog/catalog.env-resolve.js"

// Base + override semantics: the PROJECT'S base is always injected; the
// project's active context layers over it (context wins on conflicts). This was
// the old app's env model — these tests keep it from regressing again.
//
// The last two cases pin the property migration 0006 exists for: resolution
// draws only on contexts belonging to the project being spawned. A context from
// another project cannot contribute a variable, whether it is a base or the one
// a stale activeContextId happens to name.

const P1 = ProjectId.make("p1")
const P2 = ProjectId.make("p2")

const ctx = (
  id: string,
  vars: Record<string, string>,
  opts: { projectId?: ProjectId; isBase?: boolean } = {}
): EnvContext => ({
  id: ContextId.make(id),
  projectId: opts.projectId ?? P1,
  name: id,
  isBase: opts.isBase ?? false,
  vars: Object.entries(vars).map(([key, value]) => ({ key, value, secret: false }))
})

const repoWith = (contexts: ReadonlyArray<EnvContext>): EnvRepoShape => ({
  set: () => Effect.die("unused"),
  unsetVar: () => Effect.die("unused"),
  list: () => Effect.succeed(contexts),
  useContext: () => Effect.die("unused"),
  createContext: () => Effect.die("unused"),
  renameContext: () => Effect.die("unused"),
  removeContext: () => Effect.die("unused")
})

const project = (activeContextId?: string): Project =>
  ({
    id: P1,
    name: "p1",
    root: "/tmp",
    command: { name: "run", program: "sleep", args: [] },
    ports: [],
    createdAt: 0,
    updatedAt: 0,
    ...(activeContextId === undefined ? {} : { activeContextId: ContextId.make(activeContextId) })
  }) as unknown as Project

const resolve = (p: Project, contexts: ReadonlyArray<EnvContext>) =>
  Effect.runPromise(resolveEnv(p, { envRepo: repoWith(contexts) }))

describe("resolveEnv — base + context layering", () => {
  const base = ctx(
    "p1-base",
    { DATABASE_URL: "postgres://localhost/dev", LOG_LEVEL: "debug" },
    { isBase: true }
  )
  const staging = ctx("staging", { DATABASE_URL: "postgres://staging/db", EXTRA: "yes" })

  it("base vars apply with NO active context", async () => {
    assert.deepEqual(await resolve(project(), [base, staging]), {
      DATABASE_URL: "postgres://localhost/dev",
      LOG_LEVEL: "debug"
    })
  })

  it("active context overrides base on conflict, keeps base for the rest, adds its own", async () => {
    assert.deepEqual(await resolve(project("staging"), [base, staging]), {
      DATABASE_URL: "postgres://staging/db", // context wins
      LOG_LEVEL: "debug", // base survives
      EXTRA: "yes" // context adds
    })
  })

  it("context-only works without a base context existing", async () => {
    assert.deepEqual(await resolve(project("staging"), [staging]), {
      DATABASE_URL: "postgres://staging/db",
      EXTRA: "yes"
    })
  })

  it("no base, no active context → empty env", async () => {
    assert.deepEqual(await resolve(project(), [staging]), {})
  })
})

describe("resolveEnv — environments are per project", () => {
  const mine = ctx("p1-base", { LOG_LEVEL: "debug" }, { isBase: true })
  const theirs = ctx("p2-base", { AWS_SECRET_ACCESS_KEY: "leaked" }, { projectId: P2, isBase: true })

  it("another project's base contributes nothing", async () => {
    assert.deepEqual(await resolve(project(), [mine, theirs]), { LOG_LEVEL: "debug" })
  })

  it("an activeContextId naming another project's context is ignored", async () => {
    const foreign = ctx("p2-staging", { AWS_SECRET_ACCESS_KEY: "leaked" }, { projectId: P2 })
    assert.deepEqual(await resolve(project("p2-staging"), [mine, foreign]), {
      LOG_LEVEL: "debug"
    })
  })
})
