import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// operations-instructions — the user's own rules, printed verbatim.
//
// The guide says what matisa is; this says what THIS user wants done inside it
// — a port range to stay within, projects not to touch, whether an agent may
// add to the catalog on its own. Matisa neither parses nor enforces any of it:
// it is a message from the person to their agent, and the engine is the place
// it is kept so that every client reads the same copy.
//
// A separate command rather than a section of `guide` because the guide is
// static and cacheable while this changes whenever the user edits it — an agent
// that pasted the guide into its context once must still be able to re-read the
// instructions before it acts.
//
// Empty is not an error. "The user has not written any rules" is a legitimate
// answer, and an agent that treats it as a failure would refuse to work on a
// fresh install.

const set = Options.text("set").pipe(
  Options.optional,
  Options.withDescription("Replace the instructions with this text")
)

export const operations = Command.make("operations-instructions", { set }, ({ set }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer

    if (set._tag === "Some") {
      const saved = yield* call("settings.set", { operationsInstructions: set.value })
      yield* render.raw(
        { operationsInstructions: saved.operationsInstructions },
        saved.operationsInstructions === "" ? "instructions cleared" : "instructions saved"
      )
      return
    }

    const settings = yield* call("settings.get", undefined)
    yield* render.raw(
      { operationsInstructions: settings.operationsInstructions },
      settings.operationsInstructions === ""
        ? "(no operations instructions have been set)"
        : settings.operationsInstructions
    )
  })
).pipe(
  Command.withDescription(
    "Print the user's global operating rules for agents — read this before taking any action"
  )
)
