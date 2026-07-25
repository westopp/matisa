import { Args, Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { ContextId, ProjectId } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// env set|unset|list|use|create|rename|rm. --secret routes the value to the
// engine's keychain provider (only a secret_ref is persisted); `use` selects the
// active env context applied to a project on its next spawn.
//
// The context lifecycle (create/rename/rm) and `unset` are here because the
// engine has always exposed them and only the GUI could reach them — a CLI that
// can add a variable but never remove one, and can select a context but never
// make one, is a CLI you have to abandon halfway through a task.

const set = Command.make(
  "set",
  {
    context: Args.text({ name: "context" }),
    key: Args.text({ name: "key" }),
    value: Args.text({ name: "value" }),
    secret: Options.boolean("secret").pipe(Options.withDefault(false))
  },
  ({ context, key, secret, value }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const ctx = yield* call("env.set", {
        contextId: ContextId.make(context),
        key,
        value,
        secret
      })
      yield* render.envContext(ctx)
    })
)

const unset = Command.make(
  "unset",
  {
    context: Args.text({ name: "context" }),
    key: Args.text({ name: "key" })
  },
  ({ context, key }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const ctx = yield* call("env.unset", { contextId: ContextId.make(context), key })
      yield* render.envContext(ctx)
    })
)

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const ctxs = yield* call("env.list", undefined)
    yield* render.envs(ctxs)
  })
)

const use = Command.make(
  "use",
  {
    project: Args.text({ name: "project" }),
    context: Args.text({ name: "context" })
  },
  ({ context, project }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const updated = yield* call("env.use", {
        projectId: ProjectId.make(project),
        contextId: ContextId.make(context)
      })
      yield* render.projectState(updated)
    })
)

/** The engine derives the id from the name, so there is no id to invent here. */
const create = Command.make(
  "create",
  {
    name: Args.text({ name: "name" }),
    description: Options.optional(Options.text("description"))
  },
  ({ description, name }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const ctx = yield* call("env.create", {
        name,
        ...(Option.isSome(description) ? { description: description.value } : {})
      })
      yield* render.envContext(ctx)
    })
)

const rename = Command.make(
  "rename",
  {
    context: Args.text({ name: "context" }),
    name: Args.text({ name: "name" })
  },
  ({ context, name }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const ctx = yield* call("env.rename", { contextId: ContextId.make(context), name })
      yield* render.envContext(ctx)
    })
)

/** Removing a context takes its variables with it — including secret refs. */
const rm = Command.make("rm", { context: Args.text({ name: "context" }) }, ({ context }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    yield* call("env.remove", { contextId: ContextId.make(context) })
    yield* render.raw({ removed: context }, `removed env context ${context}`)
  })
)

export const env = Command.make("env").pipe(
  Command.withSubcommands([set, unset, list, use, create, rename, rm])
)
