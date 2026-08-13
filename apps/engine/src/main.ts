import { Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { StoreLive } from "@matisa/store"
import { AppConfig } from "./config/config.app-config.js"
import { CatalogLive } from "./modules/catalog/catalog.index.js"
import { DiscoveryLive } from "./modules/discovery/discovery.index.js"
import { DockerDaemonLive } from "./modules/docker/docker.index.js"
import { ResourcesLive } from "./modules/resources/resources.services.js"
import { ExposureLive } from "./modules/exposure/exposure.index.js"
import { PtyLive } from "./modules/pty/pty.index.js"
import { SupervisorLive } from "./modules/supervisor/supervisor.index.js"
import { EventsHubLive, ServerLive } from "./server/server.index.js"
import { adoptLoginPath } from "./shared/login-env.js"
import { LoggingLive } from "./telemetry/logging.js"
import { MetricsLive } from "./telemetry/metrics.js"
import { TracingLive } from "./telemetry/tracing.js"

// ────────────────────────────────────────────────────────────────────────────
// main.ts — the composition root.
//
// The socket (ServerLive) opens LAST, after every service it depends on is
// built and reconciliation has run, so clients never observe incoherent state.
// Discovery sits BELOW the supervisor rather than beside it: `lifecycle.takeover`
// has to know who is holding a project's port before it ends anything, and that
// answer is discovery's to give. The whole graph is launched with Layer.launch
// under NodeRuntime.runMain,
// which turns SIGINT/SIGTERM into fiber interruption → Scope teardown (children
// signalled, socket unlinked, DB closed). Fatal config/store faults are caught at
// the top and turned into a logged die.
//
// Dev-runner caveat: run this via `node --import tsx`, NEVER the `tsx` CLI. The
// tsx CLI forks a child whose preflight installs a hidden signal handler; after
// runMain's one-shot handler removes itself, the relayed second SIGTERM hits
// zero user listeners and tsx calls process.exit() mid-teardown — finalizers
// are skipped, orphaning children and leaving a stale socket.
// ────────────────────────────────────────────────────────────────────────────

const MainLive = ServerLive.pipe(
  Layer.provide(ExposureLive),
  Layer.provide(SupervisorLive),
  Layer.provide(CatalogLive),
  Layer.provide(DiscoveryLive),
  Layer.provide(PtyLive),
  Layer.provide(DockerDaemonLive),
  Layer.provide(ResourcesLive),
  Layer.provide(EventsHubLive),
  Layer.provide(TracingLive),
  Layer.provide(MetricsLive),
  Layer.provide(LoggingLive),
  Layer.provide(StoreLive),
  Layer.provide(AppConfig.Live)
)

// PATH adoption is sequenced AHEAD of the graph rather than merged into it as a
// peer layer: peers build concurrently with ServerLive, and the guarantee worth
// having is that no client can reach a spawn before the environment is right.
// LoggingLive is provided so this one line is formatted like every other.
const boot = adoptLoginPath.pipe(Effect.provide(LoggingLive))

const program = boot.pipe(
  Effect.andThen(Layer.launch(MainLive)),
).pipe(
  // Losing the start race is a success: a singleton daemon exists, which is
  // exactly what whoever spawned us wanted. Exit 0 so supervisors don't retry.
  Effect.catchTag("EngineAlreadyRunning", (e) =>
    Effect.logInfo(`another engine already listening on 127.0.0.1:${e.port} — exiting`)
  ),
  Effect.catchTag("InvalidConfigError", (e) =>
    Effect.logFatal(`invalid configuration: ${e.errorMessage}`).pipe(Effect.andThen(Effect.die(e)))
  ),
  Effect.catchTag("MigrationError", (e) =>
    Effect.logFatal("store migration failed").pipe(Effect.andThen(Effect.die(e)))
  )
)

NodeRuntime.runMain(program)
