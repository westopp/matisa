import { Args, Command } from "@effect/cli"
import { Effect, Option } from "effect"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"
import { resolveOptional, resolveProject } from "../cli.resolve.js"

// exposure list|share|unshare|on|off — the reverse-proxy surface.
//
// A stable URL is derived engine-side the moment a project declares a port, so
// there is nothing to create; `on`/`off` set the project's own opt-out flag and
// the reconciler does the rest. `share`/`unshare` are the separate LAN switch.
//
// Two switches rather than one on purpose: the loopback hostname and the LAN
// listener are different exposures with different reasons to be off, and a
// project can legitimately want one without the other. Mirrors the desktop.

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

// —— on | off ——
//
// The project-level switch. Writes `stableUrl` through catalog.update, which
// makes the exposure module reconcile: the row and the Caddy route go, and the
// snapshot stops reporting an address that no longer resolves. The project's
// own http://localhost:<port> is untouched — this declines the HOSTNAME, not
// the port.
const setStable = (name: "on" | "off", stableUrl: boolean) =>
  Command.make(name, { id: Args.text({ name: "id" }) }, ({ id }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const projectId = yield* resolveProject(id)
      yield* call("catalog.update", { id: projectId, patch: { stableUrl } })
      const snap = yield* call("exposure.snapshot", undefined)
      const found = snap.projects.find((p) => p.projectId === projectId)

      // Turning it OFF has no entries to print, and the generic empty line
      // ("declare a port first") would be a lie: the port is there, the
      // hostname is what was declined. Say which of the two happened.
      if (!stableUrl) {
        yield* render.raw(
          { projectId, stableUrl: false, entries: found?.entries ?? [] },
          "stable URL off — this project is no longer published through Caddy"
        )
        return
      }
      yield* render.exposureEntries(projectId, found?.entries ?? [])
    })
  ).pipe(
    Command.withDescription(
      stableUrl
        ? "Give this project its http://<name>.localhost:<caddy-port> hostname back"
        : "Stop publishing this project through Caddy — its own localhost:<port> is unaffected"
    )
  )

export const exposure = Command.make("exposure").pipe(
  Command.withSubcommands([
    list,
    setLan("share", true),
    setLan("unshare", false),
    setStable("on", true),
    setStable("off", false)
  ])
)
