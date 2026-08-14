import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"
import { resolveProject } from "../cli.resolve.js"

// start|stop|restart|kill|reset|status. Transitions return {accepted}
// immediately — the true state arrives asynchronously via events; `status`
// reads the current-state snapshot. The accept-then-observe model.
//
// `kill` and `reset` are the two the desktop had and the CLI did not, which
// made the headless surface strictly weaker at exactly the moment it matters:
// a project wedged in `stopping` (kill) or stuck `errored` after the process is
// long gone (reset) could only be freed from the window.

const idArg = Args.text({ name: "project" })

/** The five methods that share a shape: one id in, one `Accepted` out. */
type Transition =
  | "lifecycle.start"
  | "lifecycle.stop"
  | "lifecycle.restart"
  | "lifecycle.kill"
  | "lifecycle.reset"

const transition = (name: string, method: Transition) =>
  Command.make(name, { id: idArg }, ({ id }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const projectId = yield* resolveProject(id)
      const acc = yield* call(method, { id: projectId })
      yield* render.accepted(acc)
    })
  )

const status = Command.make("status", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const projectId = yield* resolveProject(id)
    const st = yield* call("lifecycle.status", { id: projectId })
    yield* render.status(st)
  })
)

export const lifecycle = Command.make("lifecycle").pipe(
  Command.withSubcommands([
    transition("start", "lifecycle.start"),
    transition("stop", "lifecycle.stop"),
    transition("restart", "lifecycle.restart"),
    transition("kill", "lifecycle.kill"),
    transition("reset", "lifecycle.reset"),
    status
  ])
)
