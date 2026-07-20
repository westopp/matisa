import { Command } from "@effect/cli"
import { globals } from "./cli.globals.js"
import * as C from "./commands/commands.index.js"

// The command tree: the global-options root (matisa) with every command group
// attached. Handlers return Effects needing EngineClient | Renderer | ClientConfig,
// satisfied by the layer in main.ts. @effect/cli supplies --help + completions.

export const cli = globals.pipe(
  Command.withSubcommands([
    C.project, // add | list | update | rm
    C.env, // set | list | use
    C.lifecycle, // start | stop | restart | status
    C.watch, // live push stream
    C.events, // cursor pull
    C.pty // sh | logs -f
  ])
)
