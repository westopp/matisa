import { Command } from "@effect/cli"
import { globals } from "./cli.globals.js"
import * as C from "./commands/commands.index.js"

// The command tree: the global-options root (matisa) with every command group
// attached. Handlers return Effects needing EngineClient | Renderer | ClientConfig,
// satisfied by the layer in main.ts. @effect/cli supplies --help + completions.

export const cli = globals.pipe(
  Command.withSubcommands([
    C.project, // add | list | update | rm (process | docker | compose kinds)
    C.env, // set | list | use (base + context layering)
    C.lifecycle, // start | stop | restart | status
    C.watch, // live push stream
    C.events, // cursor pull
    C.pty, // sh | logs (session-level)
    C.commandsGroup, // named commands: set | list | rm
    C.run, // run <project> <command> — interactive PTY
    C.group, // group set | list | rm
    C.exposure, // exposure list | share | unshare (stable URLs + LAN)
    C.discovery, // discovery list | stop | start — what matisa did NOT start
    C.takeover, // takeover <id> — reclaim a project running outside the engine
    C.engine, // engine status | start | stop
    C.docker, // docker daemon status | start | stop
    C.logs, // logs <id> [--lines N] [-f]
    C.failures, // recorded crash history (the WHY)
    C.resources // cpu/rss snapshot
  ])
)
