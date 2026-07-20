import { Context, Effect, Layer } from "effect"
import type { ProjectId } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// Exposure — STUB. The full module guards strict ports and drives Caddy / sish /
// mDNS providers for stable URLs, tunnels and mDNS, reacting to Supervisor state.
// Here it is a typed no-op; no exposure.* method is on the wire yet. Boot-logged.
// ────────────────────────────────────────────────────────────────────────────

export interface ExposureShape {
  readonly guardPort: (port: number) => Effect.Effect<void>
  readonly enableUrl: (projectId: ProjectId) => Effect.Effect<void>
  readonly disableUrl: (projectId: ProjectId) => Effect.Effect<void>
}

export class Exposure extends Context.Tag("Exposure")<Exposure, ExposureShape>() {}

export const ExposureLive = Layer.effect(
  Exposure,
  Effect.gen(function* () {
    yield* Effect.logInfo(
      "STUB: exposure module (caddy/tunnel/mdns providers not implemented) — no-op"
    )
    return Exposure.of({
      guardPort: () => Effect.void,
      enableUrl: () => Effect.void,
      disableUrl: () => Effect.void
    })
  })
)
