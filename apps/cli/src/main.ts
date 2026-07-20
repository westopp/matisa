#!/usr/bin/env node
import { Command, ValidationError } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { cli } from "./cli.command.js"
import { ClientConfigLive } from "./config/config.client-config.js"
import { EngineClientLive } from "./transport/transport.index.js"
import { RendererLive } from "./render/render.index.js"
import { exitCodeFor } from "./cli.exit.js"

// ────────────────────────────────────────────────────────────────────────────
// Composition root. Parses argv, provides the client layers, runs under
// NodeRuntime.runMain, and turns the typed error channel into an exit code via
// cli.exit. The only file that touches process.argv / process.exit.
// ────────────────────────────────────────────────────────────────────────────

const run = Command.run(cli, {
  name: "matisa",
  version: "0.1.0"
})

// One layer graph shared by every command handler. The socket (EngineClientLive)
// and config are scoped, so they open once per invocation and release when
// runMain finishes — including on Ctrl-C. provideMerge re-exports NodeContext so
// @effect/cli's own environment (FileSystem/Path/Terminal) is satisfied too.
const AppLive = Layer.mergeAll(EngineClientLive, RendererLive).pipe(
  Layer.provideMerge(ClientConfigLive),
  Layer.provideMerge(NodeContext.layer)
)

run(process.argv).pipe(
  // @effect/cli prints its own usage/help for parse failures; map the whole
  // ValidationError family to the usage exit code (help requests exit 0) without
  // re-printing. What remains in the channel is our AppError union.
  Effect.catchIf(ValidationError.isValidationError, (e) =>
    Effect.sync(() => {
      process.exitCode = e._tag === "HelpRequested" ? 0 : 4
    })
  ),
  Effect.provide(AppLive),
  Effect.catchAllCause((cause) =>
    exitCodeFor(cause).pipe(
      Effect.flatMap((code) =>
        Effect.sync(() => {
          process.exitCode = code
        })
      )
    )
  ),
  NodeRuntime.runMain
)
