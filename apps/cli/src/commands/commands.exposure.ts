import { Args, Command } from "@effect/cli"
import { Effect, Option } from "effect"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"
import { resolveOptional, resolveProject } from "../cli.resolve.js"

// exposure list|share|unshare — the reverse-proxy surface. Stable URLs are
// derived engine-side the moment a project declares a port (no command needed
// to create them); these commands only READ the resolved addresses and toggle
// the one opt-in bit, LAN sharing. Mirrors the desktop hero, headless.

// —— list ——
//
// No id → every exposed project + caddy status. An id → just that project's
// entries (filtered from the same snapshot, so an unexposed/unknown id renders
// the empty "declare a port first" line rather than erroring).
const list = Command.make(
  "list",
  { id: Args.text({ name: "id" }).pipe(Args.optional) },
  ({ id }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const target = yield* resolveOptional(id)
      const snap = yield* call("exposure.snapshot", undefined)
      if (target === undefined) {
        yield* render.exposureSnapshot(snap)
        return
      }
      const found = snap.projects.find((p) => p.projectId === target)
      yield* render.exposureEntries(target, found?.entries ?? [])
    })
)

// —— share | unshare ——
//
// Toggle LAN sharing (mDNS hostname + dedicated LAN listener). The engine
// rebinds Caddy to 0.0.0.0, spawns dns-sd, and returns the project's full entry
// set so the new/removed addresses print immediately. `E_CADDY_UNAVAILABLE` and
// the no-port validation error surface verbatim via the transport error path.
const setLan = (name: "share" | "unshare", enabled: boolean) =>
  Command.make(name, { id: Args.text({ name: "id" }) }, ({ id }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const projectId = yield* resolveProject(id)
      const { entries } = yield* call("exposure.lan.set", { id: projectId, enabled })
      yield* render.exposureEntries(projectId, entries)
    })
  )

export const exposure = Command.make("exposure").pipe(
  Command.withSubcommands([list, setLan("share", true), setLan("unshare", false)])
)
