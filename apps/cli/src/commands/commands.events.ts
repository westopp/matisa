import { Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { Events } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// events --since <cursor> — the pull path. Drains the durable queue from a
// cursor, prints each event and the next cursor for the caller to persist. The
// scriptable, resumable counterpart to watch.

export const events = Command.make(
  "events",
  {
    since: Options.integer("since").pipe(Options.withDefault(0)),
    limit: Options.integer("limit").pipe(Options.withDefault(512)),
    project: Options.optional(Options.text("project"))
  },
  ({ limit, project, since }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const batch = yield* Events.pull(since, limit, Option.getOrUndefined(project))
      yield* Effect.forEach(batch.events, (e) => render.event(e))
      yield* render.cursor(batch.next)
    })
)
