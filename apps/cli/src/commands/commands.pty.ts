import { Args, Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { SessionId } from "@matisa/core"
import { Pty } from "../transport/transport.index.js"
import { applyGlobals } from "../cli.globals.js"

// sh <id> and logs -f <session>. Thin wrappers over transport.pty — open an
// interactive session or attach to a run's live output; all raw-mode / resize
// handling lives in transport.pty.

const sh = Command.make(
  "sh",
  {
    id: Args.text({ name: "id" }),
    cmd: Options.optional(Options.text("cmd")),
    cols: Options.integer("cols").pipe(Options.withDefault(80)),
    rows: Options.integer("rows").pipe(Options.withDefault(24))
  },
  ({ cmd, cols, id, rows }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      yield* Pty.open(id, Option.getOrUndefined(cmd), cols, rows)
    })
)

const logs = Command.make(
  "logs",
  {
    session: Args.text({ name: "session" }),
    follow: Options.boolean("follow").pipe(
      Options.withAlias("f"),
      Options.withDefault(true)
    )
  },
  ({ session }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      yield* Pty.attach(SessionId.make(session))
    })
)

export const pty = Command.make("pty").pipe(
  Command.withSubcommands([sh, logs])
)
