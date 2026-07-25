import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { ContextId, ProjectId, type EnvContext, type Project } from "@matisa/core"
import type { EnvRepoShape } from "@matisa/store"
import { resolveEnv } from "../modules/catalog/catalog.env-resolve.js"

// Base + override semantics: `base` context vars are ALWAYS injected; the
// project's active context layers over them (context wins on conflicts).
// This was the old app's env model — these tests keep it from regressing again.

const ctx = (id: string, vars: Record<string, string>): EnvContext => ({
  id: ContextId.make(id),
  name: id,
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
    id: ProjectId.make("p1"),
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
  const base = ctx("base", { DATABASE_URL: "postgres://localhost/dev", LOG_LEVEL: "debug" })
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
