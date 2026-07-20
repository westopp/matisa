import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { ContextId, ProjectId } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// env set|list|use. --secret routes the value to the engine's keychain provider
// (only a secret_ref is persisted); `use` selects the active env context applied
// to a project on its next spawn.

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

export const env = Command.make("env").pipe(
  Command.withSubcommands([set, list, use])
)
