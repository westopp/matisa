import { Context, Effect, Layer } from "effect"

// ────────────────────────────────────────────────────────────────────────────
// Discovery — STUB. The full module assembles a DiscoverySnapshot behind a
// Ref + Schedule TTL cache from lsof / docker / brew probes. Here it returns an
// empty snapshot; no discovery.* method is on the wire yet, so nothing depends on
// live data. Boot-logged so the stub is visible.
// ────────────────────────────────────────────────────────────────────────────

export interface DiscoverySnapshot {
  readonly listeningPorts: ReadonlyArray<number>
  readonly containers: ReadonlyArray<string>
  readonly composeStacks: ReadonlyArray<string>
  readonly brewServices: ReadonlyArray<string>
  readonly daemonRunning: boolean
}

export interface DiscoveryShape {
  readonly snapshot: () => Effect.Effect<DiscoverySnapshot>
}

export class Discovery extends Context.Tag("Discovery")<Discovery, DiscoveryShape>() {}

const EMPTY: DiscoverySnapshot = {
  listeningPorts: [],
  containers: [],
  composeStacks: [],
  brewServices: [],
  daemonRunning: false
}

export const DiscoveryLive = Layer.effect(
  Discovery,
  Effect.gen(function* () {
    yield* Effect.logInfo(
      "STUB: discovery module (lsof/docker/brew probes not implemented) — snapshot is empty"
    )
    return Discovery.of({ snapshot: () => Effect.succeed(EMPTY) })
  })
)
