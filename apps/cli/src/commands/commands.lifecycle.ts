import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { ProjectId } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// start|stop|restart|status. Transitions return {accepted} immediately — the
// true state arrives asynchronously via events; `status` reads the current-state
// snapshot. The accept-then-observe model.

const idArg = Args.text({ name: "id" })

const start = Command.make("start", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const acc = yield* call("lifecycle.start", { id: ProjectId.make(id) })
    yield* render.accepted(acc)
  })
)

const stop = Command.make("stop", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const acc = yield* call("lifecycle.stop", { id: ProjectId.make(id) })
    yield* render.accepted(acc)
  })
)

const restart = Command.make("restart", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const acc = yield* call("lifecycle.restart", { id: ProjectId.make(id) })
    yield* render.accepted(acc)
  })
)

const status = Command.make("status", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const st = yield* call("lifecycle.status", { id: ProjectId.make(id) })
    yield* render.status(st)
  })
)

export const lifecycle = Command.make("lifecycle").pipe(
  Command.withSubcommands([start, stop, restart, status])
)
