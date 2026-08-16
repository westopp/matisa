import { Command } from "@effect/cli"
import { Console } from "effect"
import { GUIDE } from "../cli.guide.js"

// guide — print the agent-facing description of the whole application.
//
// Deliberately the one command that touches neither the transport nor the
// globals: it answers "what is this and how do I drive it", which is exactly
// the question asked when the engine is NOT up and the answer must not depend
// on reaching it. It also ignores --json — the payload is documentation, and a
// JSON-wrapped wall of text is worse to read in both modes.
//
// Registered first in the command tree so it heads the COMMANDS list in
// `matisa --help`, which is where an agent looks before anything else.

export const guide = Command.make("guide", {}, () => Console.log(GUIDE)).pipe(
  Command.withDescription(
    "Print the full agent-facing guide to matisa: the model, every command, and how to script it"
  )
)
