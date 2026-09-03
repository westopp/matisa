import { Args, Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
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

/** One-off environment for this spawn: a context id, or its name within the
 *  project. Deliberately NOT `env use` — that selects the project's context and
 *  leaves it selected, which is a persistent edit an agent has no safe way to
 *  undo if it dies mid-task, and which two agents on one project will race. */
const contextOption = Options.text("context").pipe(
  Options.withDescription(
    "run this spawn with the named environment, without changing the project's selection"
  ),
  Options.optional
)

/** The transitions that take an id and nothing else, one `Accepted` out. */
type Transition = "lifecycle.stop" | "lifecycle.kill" | "lifecycle.reset"

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

/** start and restart only: the other three transitions have no spawn to give an
 *  environment to — stop and kill end one, and reset touches no process at all. */
const spawning = (name: string, method: "lifecycle.start" | "lifecycle.restart") =>
  Command.make(name, { id: idArg, context: contextOption }, ({ context, id }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const projectId = yield* resolveProject(id)
      const acc = yield* call(method, {
        id: projectId,
        context: Option.getOrUndefined(context)
      })
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
    spawning("start", "lifecycle.start"),
    transition("stop", "lifecycle.stop"),
    spawning("restart", "lifecycle.restart"),
    transition("kill", "lifecycle.kill"),
    transition("reset", "lifecycle.reset"),
    status
  ])
)
