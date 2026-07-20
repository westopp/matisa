import { Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { ClientConfig } from "./config/config.client-config.js"

// The root command's global options, in their own module so every subcommand can
// read them (via `yield* globals`) without a circular import through the tree.

export const jsonOption = Options.boolean("json").pipe(Options.withDefault(false))
export const socketOption = Options.text("socket").pipe(Options.optional)
export const ensureOption = Options.boolean("ensure-engine").pipe(
  Options.withDefault(false)
)

export const globals = Command.make("matisa", {
  json: jsonOption,
  socket: socketOption,
  ensure: ensureOption
})

export interface Globals {
  readonly json: boolean
  readonly socket: Option.Option<string>
  readonly ensure: boolean
}

// Read the parsed globals and apply the --socket / --json overrides onto the
// ClientConfig before the transport lazily connects. Every handler starts here.
export const applyGlobals = Effect.gen(function* () {
  const g = (yield* globals) as Globals
  const config = yield* ClientConfig
  yield* config.setSocket(g.socket)
  yield* config.setJson(g.json)
  return g
})
