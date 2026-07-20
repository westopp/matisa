import { Command, Options } from "@effect/cli"
import { Effect, Option, Stream } from "effect"
import { Events } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// watch — the push path. Holds the connection, consumes the live event stream,
// and renders each state_changed / crash / exposure line as it happens.

export const watch = Command.make(
  "watch",
  { project: Options.optional(Options.text("project")) },
  ({ project }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      yield* Events.subscribe(Option.getOrUndefined(project)).pipe(
        Stream.runForEach((e) => render.event(e))
      )
    })
)
