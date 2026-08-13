import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { ProjectId } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// ────────────────────────────────────────────────────────────────────────────
// discovery — what is running on this machine that matisa did not start.
//
// This is the command an agent runs before concluding "the API is down": a
// project can be perfectly alive and still read `idle` here, because someone
// started it in a terminal. `discovery list` says so explicitly, names the
// directory the process is running from as its evidence, and points at the one
// command that resolves it.
//
// `stop` and `start` act on a `ref` copied straight out of that listing. They
// are deliberately not "adopt": stopping a stranger's container is a favour,
// not a claim of ownership, and nothing about it edits the catalog.
// ────────────────────────────────────────────────────────────────────────────

const refArg = Args.text({ name: "ref" })

const refresh = Options.boolean("refresh").pipe(
  Options.withDescription(
    "Force a new sweep instead of reusing a result cached in the last few seconds"
  )
)

const list = Command.make("list", { refresh }, ({ refresh }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const snap = yield* call("discovery.snapshot", { refresh })
    yield* render.discovery(snap)
  })
)

const stop = Command.make("stop", { ref: refArg }, ({ ref }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const result = yield* call("discovery.stop", { ref })
    yield* render.discoveryAction(result)
  })
)

const start = Command.make("start", { ref: refArg }, ({ ref }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const result = yield* call("discovery.start", { ref })
    yield* render.discoveryAction(result)
  })
)

export const discovery = Command.make("discovery").pipe(
  Command.withSubcommands([list, stop, start])
)

// ── takeover ────────────────────────────────────────────────────────────────
//
// Top-level rather than buried under `lifecycle`, because it is the answer to
// the most common thing `discovery list` reports, and a two-word path is what
// gets used. `--force` is required whenever the only link between the holder
// and the project is the port number: the engine refuses that case by default
// and says why, since killing the wrong process is the one outcome here that
// cannot be undone.

const force = Options.boolean("force").pipe(
  Options.withDescription(
    "Proceed even when the process holding the port is not recognisably this project's"
  )
)

export const takeover = Command.make(
  "takeover",
  { id: Args.text({ name: "id" }), force },
  ({ id, force }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const acc = yield* call("lifecycle.takeover", { id: ProjectId.make(id), force })
      yield* render.accepted(acc)
    })
)
