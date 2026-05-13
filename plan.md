# Matisa Engine Migration — Plan & Handoff

This document is the **single source of truth for cross-session work** on the engine migration. New sessions should read this top-to-bottom before doing anything.

---

## What we're building

Matisa is a macOS dev-environment manager (manages Docker containers, dev-server processes, Caddy reverse-proxy config, env vars per service, public tunnels via sish, same-network mDNS advertisements, ad-hoc build/script tasks). All state and orchestration currently lives inside the SwiftUI app's `ServiceStore` (~1100 lines).

We're migrating to an architecture where a **separate engine process** owns all state and orchestration. Multiple clients talk to it over a local Unix domain socket via JSON-RPC 2.0:

```
                         launchd (primary mechanism)
                                  │
                            ┌─────▼─────┐
            ┌───────────────│  Engine   │───────────────┐
            │               │  (1 only) │               │
            │               └─────▲─────┘               │
            │                     │                     │
         ┌──▼──┐  ┌─────┐  ┌──────┴───┐  ┌─────────┐
         │ App │  │Widget│ │   CLI    │  │   MCP   │
         └─────┘  └─────┘  └──────────┘  └─────────┘
```

**Why:** so coding agents can drive Matisa programmatically (the original motivating feature), the desktop widget can show live state without the app being open, and the CLI can script anything the GUI can do.

---

## Architecture decisions (locked in)

| Decision | Choice | Why |
|---|---|---|
| Wire format | JSON-RPC 2.0 over UDS, NDJSON framing | Language-agnostic, easy to debug with `nc -U` / `socat`, supports notifications for future streaming |
| Single instance | flock on sibling lockfile (`<sock>.lock`) | Prevents two engines stealing each other's socket |
| Socket location | `~/Library/Application Support/Matisa/matisa.sock`, override via `MATISA_SOCKET` | Standard macOS app-data location; env var for tests |
| Engine lifetime | App stays running with no UI today; `SMAppService`-managed launchd helper in Phase 8 | Lets us defer the lifecycle complexity |
| Quit semantics | Quit closes UI only, projects keep running | Matches Docker Desktop / OrbStack expectations |
| Method naming | Dotted namespaces, lowercase: `engine.status`, `services.start`, `docker.daemon.start` | Scales to a large surface |
| Engine language | Swift (same as app) | Single codebase, share types via `MatisaCore` |
| Engine startup policy | App auto-launches it; widget/CLI/MCP fail-loud | Different defaults match each client's context |
| Env vars over wire | Names only, no values, ever | Even local clients shouldn't read secrets — agent context is the realistic threat |
| Single TS source for shared code | `MatisaCore` library target | Both `Matisa` (app) and `MatisaEngine` (binary) depend on it |

### Asymmetric client policies — engine missing

| Client | Behavior | Notes |
|---|---|---|
| App | Silently auto-starts | UI users expect "just works" |
| Widget | Show stale App-Group snapshot + tap-to-start | Phase 7, not yet built |
| CLI | Fail loud; opt-in via `--ensure-engine` flag or `matisa engine start` | Phase 4, not yet built |
| MCP | Fail loud; agent asks user | Phase 6, not yet built |

### Asymmetric client policies — actions exposed

`engine.shutdown` exists on the wire; not every client surfaces it.

| Client | Surfaces shutdown? |
|---|---|
| App | Yes — explicit "Stop engine and quit" menu item (separate from Quit) |
| CLI | Yes — `matisa engine stop` |
| MCP | No (probably) — too destructive for an agent to invoke casually |
| Widget | No |

---

## Code layout

```
Sources/
  MatisaCore/             # Shared library (engine + app both depend on it)
    Models/               # ServiceSpec, ServiceState, BuildSpec, Service,
                          # ServicesSnapshot, PersistedSpawn — all Codable
    Config/               # Config.swift (raw shapes for bun-evaluated config)
    Discovery/            # ListeningPort, DockerContainer, DockerComposeStack,
                          # BrewService, DiscoverySnapshot + parsers,
                          # UnmanagedHeuristics, ContainerNaming
    State/                # ServiceMerge (pure function — engine + app fallback share)
    CorePaths.swift       # Shared file-system locations (state file, log dir)
  MatisaEngine/           # Engine binary (executable target)
    main.swift            # Entry, signal handling, dispatchMain
    Engine.swift          # Top-level wiring — registers RPC methods
    Server.swift          # UnixSocketServer (POSIX UDS, lockfile, accept loop)
    Connection.swift      # ConnectionHandler — sync run() bridging to async dispatch
    Envelope.swift        # JSONRPCEnvelope — async JSON-RPC parse/dispatch
    LineReader.swift      # NDJSON line reader (sync read(2) on dispatch worker)
    RPC.swift             # MethodDispatcher (async handlers since 2c.0) + RPCError
                          # (parse/invalidRequest/methodNotFound/invalidParams/
                          # internalError + dockerDaemonRequired -32001,
                          # serviceNotFound -32002)
    Methods.swift         # Engine-only shapes (EngineStatus, ServiceIDParams,
                          # EmptyResponse)
    ConfigService.swift   # Phase 2a — bun runner with mtime cache
    Discovery/            # Phase 2b.1 — sync ports of probes
      SyncShell.swift     # Sync Process helper (replaces Shell.runCapturing)
      SyncProbes.swift    # SyncLsof, SyncDocker, SyncBrew
      SyncProcess.swift   # Phase 2b.2 — isAlive + sync ProcessIntrospect
      DiscoveryService.swift  # Snapshot builder + 1-second TTL cache
    Supervisor/           # Process & shell primitives shared across services
      EngineShell.swift   # Async port of app's Shell.run + ShellError (2c.1)
      LifecycleSupervisor.swift  # posix_spawn, signal escalation, isAlive (2c.1)
      DockerActions.swift # Inline/compose/unmanaged container CLI (2c.1)
      LogRotator.swift    # Port of app's log rotator (type ready; engine
                          # timer wiring still pending — see Open decisions)
      EngineBrew.swift    # Async brew services start/stop/restart (2d)
    Caddy/                # (in MatisaCore — see above)
    State/                # Per-subsystem orchestrators
      PersistedSpawnStore.swift  # Read/write state.json with serial queue +
                                 # atomic Data.write(.atomic) (2c.1)
      ServicesService.swift      # Orchestrates config + discovery + spawns
                                 # → merge; prunes deadSpawnIDs (2b.2 + 2c.2);
                                 # postSnapshotHook drives 2e.1 auto-teardown
      LifecycleService.swift     # services.{start,stop,kill,restart,take_over,
                                 # pull}, launch_failures.{list,clear},
                                 # detached launch-watcher with PID-identity
                                 # guard + cancellation map (2c.2)
      DockerDaemonService.swift  # Phase 2f — DockerSystemState machine,
                                 # awaitDaemonReady poll on a cancellable Task
      CaddyService.swift         # Phase 2d — brew-managed Caddy lifecycle,
                                 # validate, atomic regenerate, 150ms
                                 # scheduleRegenAndReload debouncer; reads
                                 # exposures via 2e.2-wired loadExposures
      TaskService.swift          # Phase 2e.3 — per-(serviceID, kind) ad-hoc
                                 # tasks (build / script) with buffered output
      TunnelService.swift        # Phase 2e.1 — public tunnels (sish),
                                 # lifecycle-aware auto-teardown via the
                                 # ServicesService postSnapshotHook
      MDNSService.swift          # Phase 2e.2 — same-network mDNS via dns-sd,
                                 # NWPathMonitor-driven re-publish, fires
                                 # CaddyService.scheduleRegenAndReload on
                                 # state change
  Matisa/                 # The macOS UI app (executable target)
    App.swift, Window/, Store/, Supervisor/, Discovery/,
    Engine/EngineClient.swift, Engine/EngineLauncher.swift,
    Engine/EngineMirror.swift, Window/EngineDetailView.swift, ...
                          # Supervisor + Discovery now power the local-fallback
                          # path when the engine is unreachable. EngineLauncher
                          # spawns / locates the engine binary; the app calls it
                          # at launch and on every engineUnreachable retry.
Tests/
  MatisaCoreTests/        # Codable round-trips + parser tests + ServiceMerge tests
  MatisaEngineTests/      # JSONRPCEnvelopeTests, LineReaderTests,
                          # PersistedSpawnStoreTests, LifecycleSupervisorTests,
                          # LifecycleServiceTests, DockerDaemonServiceTests,
                          # CaddyServiceTests, TaskServiceTests,
                          # TunnelServiceTests, MDNSServiceTests
  MatisaTests/            # Pre-existing app tests (LsofParserTests, ConfigTests)
```

---

## What's done

In the order it landed (most recent at top):

| Commit | Slice | Summary |
|---|---|---|
| `11d9ef4` | **EnvironmentSection merged view** | The env section's context tabs (`dev`, `test`, …) used to render only that context's overrides, hiding the base vars that are also injected at runtime — misleading. Now renders the context vars on top, a divider, then the base vars below. Base entries whose names are shadowed by the context appear struck-through with an explanatory tooltip, so the override relationship is visible. The default tab still shows just `env.base`. |
| `a6eb8f9` | **Phase 2f follow-up** | `DockerDaemonService` initialised state at `.unknown` and only transitioned out of it on user-driven actions (`start`/`stop`/`clearFailure`/`finishStart`) — pre-Phase-3 the app's local-fallback path drove autonomous transitions from the live probe, but Phase 3 made the engine always-on and exposed the gap (Docker row stuck on "Checking…" even when Docker was running). New `reconcileFromLiveProbe(running:)` on `DockerDaemonService`, called from `ServicesService.snapshot()` via a setter-injected `dockerStateReconcile` closure wired in `Engine.init`, drives `.unknown / .running / .stopped` from the live probe each tick and clears `.startFailed → .running` if the daemon came up some other way. UI-driven `.starting` is preserved (the daemon-ready poll owns that transition). App-side defence in depth: `ServiceStore.refresh` falls back to the live discovery probe when the engine reports `.unknown`. 5 new tests cover each transition arm. |
| `218b05d` | **Phase 3 engine-lifecycle slice** | Engine is now a first-class peer of the app, not a dev-only sidecar. New `engine.shutdown` RPC raises SIGTERM on a 100ms delay so callers can stop the engine cleanly over the wire. `build-app.sh` bundles `matisa-engine` into `Matisa.app/Contents/MacOS/` alongside `Matisa`. New `EngineLauncher` (app-side) resolves the binary path (env override → bundle sibling → `.build/<config>` for dev), polls the socket for readiness, and `posix_spawn`s the engine with `POSIX_SPAWN_SETSID` so it survives the app — stdout/stderr go to `~/Library/Logs/Matisa/engine.log`. App auto-calls `EngineLauncher.ensureRunning` at launch; `EngineClient.callEnsuringEngine` retries any RPC once if the socket is unreachable. `EngineMirror` polls `engine.status` per refresh; `ServiceStore.engineStatus` exposes it to the UI. New Engine row in the System group of the sidebar (Caddy / Docker / Engine), with start/stop controls and `EngineDetailView` (version, uptime, socket path) modeled on the sibling system-row detail views. Stop wait-loops on `isReachable` to avoid the Stopped→Running→Stopped flicker between shutdown-ack and SIGTERM. |
| `b7a6a14` | **Phase 2e.2** | Same-network (mDNS) moves to the engine. New `MDNSService` ports `MDNSPublisher` (`dns-sd -P` per active hostname, `NWPathMonitor` for Wi-Fi / sleep-wake, the same `sanitisedHostname` / `primaryLANIPv4` algorithms). State changes fire `onStateChanged` which the engine wires to `CaddyService.scheduleRegenAndReload` — the dormant 2d debouncer finally has callers. `CaddyService.loadExposures` is now a settable closure that combines `TunnelService.list()` + `MDNSService.list()` into a `[String: ServiceExposure]` map; `regenerate` passes it to `CaddyfileGenerator.write`, so the engine-rendered Caddyfile finally carries the runtime `<service>.matisa.local` and tunnel blocks. New `exposure.same_network.toggle/status/list` RPCs and `SameNetworkStatusList` wire type. App's `toggleSameNetwork` and `regenerateCaddyfile` switch to engine-first; the local-fallback `scheduleCaddyRegenLocal` keeps the 150ms debounce for the engine-unreachable branch. |
| `6a9823b` | **Phase 2e.1** | Public tunnels (sish) move to the engine. New `TunnelService` ports `TunnelManager` (one `Foundation.Process` per active tunnel, banner-parsed hostnames from sish's stderr, the same SSH arg vector + `-o` flags + pipe wiring). All toggle gating (running, ssh key present, port available) runs engine-side. `ServicesService.postSnapshotHook` is the lifecycle-transition detector — `TunnelService.reconcileAfterSnapshot` SIGTERMs active tunnels for services that just stopped, inside the same `services.snapshot` tick so clients never see "service stopped, tunnel still live". New `exposure.public_tunnel.toggle/status/list` RPCs + `PublicTunnelStatusList` wire type. App's `togglePublicTunnel` routes through the engine; `refresh()` feeds `exposure.public_tunnel.list` into `TunnelManager.replaceStatusesFromEngine`, which preserves locally-spawned tunnels by Process liveness. The app's pre-2e.1 in-line auto-teardown runs only on the engine-unreachable fallback. |
| `c084cf7` | **Phase 2e.3** follow-up | `replaceSlotsFromEngine` was wiping the local slot map for any service the engine reported `{}` for — including locally-spawned tasks whose pid was tracked only in that slot. Preserve slots with `pid > 0` during the engine-mirror (they're app-owned, not engine-owned). Engine-owned slots always have `pid == 0`. Also fix `TaskService.clear` materialising ghost `.idle` entries when called for an unknown `(serviceID, kind)`. |
| `67623d0` | **Phase 2e.3** | `TaskRunner` (ad-hoc build / script process runner) moves to the engine. New `TaskService` owns per-`(serviceID, kind)` slots, `Foundation.Process` spawn, stdout/stderr buffering (200KB cap), `SIGTERM→SIGKILL` cancellation. Wire types `TaskKind`, `TaskState`, `TaskSlot`, `TaskList` in MatisaCore — `TaskList` manual-Codable so it serialises as `{"build": ..., "script": ...}` instead of Foundation's default array-of-pairs. 5 RPCs: `tasks.start/cancel/clear/close_pane/list`. App's `runBuild`/`runScript`/`stopTask`/`clearTask`/`closeTaskPane` route through the engine first; `refresh()` polls `tasks.list(id)` for services with a visible pane and replaces the local slots via `TaskRunner.replaceSlotsFromEngine`. Engine-driven tasks write a placeholder `.running` slot into the local runner so SwiftUI bindings keep working immediately. |
| `4009424` | **Phase 2d** follow-up | App's `regenerateCaddyfile` was routing through the engine's `caddy.regenerate`, which rendered with `exposures: [:]` because `TunnelManager` / `MDNSPublisher` still lived app-side. Toggle-driven regen (`scheduleCaddyRegen → regenerate`) would wipe `<service>.matisa.local` blocks the moment they were published. Until 2e moves exposures into `CaddyService.regenerate`, always render locally. Also: inject `DiscoveryService` into `CaddyService` so `brewProbe` reads the 1s-TTL cached snapshot instead of double-shelling `brew services list` per refresh tick. |
| `4ec37b9` | **Phase 2d** | Caddy lifecycle + Caddyfile generation move to the engine. `CaddyfileGenerator` moves into MatisaCore (public, both targets share one renderer). New `CaddyServiceInfo` + `CaddyValidationResult` wire types in MatisaCore. `EngineBrew` ports the app's `BrewServices.start/stop/restart` (`SyncBrew.list` already lived engine-side for the discovery probe). New `CaddyService` owns the brew-managed lifecycle, validate, atomic-write `regenerate`, and the 150ms `scheduleRegenAndReload` debouncer (engine-internal — 2e.2 wires the trigger). 7 RPCs: `caddy.status/start/stop/restart/reload/validate/regenerate`. App's `performCaddy` / `validateCaddy` / `reloadCaddy` / `regenerateCaddyfile` route through the engine first with `*Local` fallbacks; `refresh()` pulls `caddy.status` into `self.caddyService`. |
| `28dbe9a` | **Phase 2f** follow-up | `start()`'s state transition and `startTask` assignment ran in two separate `queue.sync` blocks. Since the engine's worker queue is `.concurrent`, a `cancelStart()` could land between those writes, observe state `.starting` but `startTask == nil`, write `.stopped` and bail without cancelling the task — `finishStart` would then race in and stomp `.stopped` with `.running` or `.startFailed`. Cancel silently lost. Collapse `start()` into a single `queue.sync`. Add injectable `readyTimeout` / `pollIntervalNS` test seams so the `.startFailed → .stopped` arm of `clearFailure` is exercised in ~50ms. Guard `refresh()` against overwriting a fresh local `.starting` with an engine snapshot from before the user clicked. |
| `90684cf` | **Phase 2f** | Docker daemon control moves to the engine. New `DockerDaemonService` owns the `DockerSystemState` machine (`.unknown / .running / .stopped / .starting / .startFailed`) behind a serial queue, runs the `awaitDaemonReady` poll loop on a cancellable Task, exposes the same semantics the app had (concurrent `start()` while `.starting` is a no-op, `cancelStart` SIGTERMs the task and fires graceful quit, etc.). 5 RPCs: `docker.daemon.status/start/stop/cancel_start/clear_failure`. App's `performDockerStart` / `performDockerStop` / `cancelDockerStartInFlight` / `clearDockerStartFailure` / `confirmDockerStart` route through the engine with `*Local` helpers as fallback. `dockerSystem` on `ServiceStore` is now engine-mirrored during refresh. |
| `cdb6465` | **Phase 2c.3** follow-up | Restore the `dockerSystem.isStarting` short-circuit in `perform()` that was dropped when the daemon pre-probe came out. Stop writing transient `.error("engine: ...")` labels on non-(-32001) RPC errors — the trailing `refresh()` overwrites them within milliseconds via `services.snapshot`, so the user only saw a one-frame flicker. Log to stderr for now; UI surfacing is a known gap (see Open decisions). |
| `9ea0b14` | **Phase 2c.3** | App's `ServiceStore` lifecycle methods route through the engine first (`services.start/stop/kill/restart/take_over/pull`, `launch_failures.list/clear`) and fall back to the existing local logic only when the engine is unreachable. Six new top-level wrappers with a four-arm catch (-32001 → prompt; other rpcError → log; transport → fall through to `*Local`; success → trailing `refresh()` reflects engine state). Local logic preserved verbatim in `*Local` helpers; `StatePersistence.upsert/remove` confined to those. `refresh()` pulls `launch_failures.list` in the engine-reachable branch and replaces the local map. `clearLaunchFailure` drops the local entry then fires the engine RPC best-effort. |
| `c68707b` | **Phase 2c.2** follow-up | Launch-watcher cancellation tracker (cancel prior watcher on retry / restart / stop), PID-identity guard inside the watcher (refuse to write `LaunchFailure` or remove a `PersistedSpawn` if the persisted PID no longer matches the watched PID). Drop `recordDockerFailure` calls from `stop`/`kill`/`restart`/`pull` paths (they aren't launches). New `RPCError.serviceNotFound` at -32002. `PersistedSpawnStore` injected into both services from `Engine.init` instead of being exposed via a `spawnStoreRef` accessor. Top-of-file caveat in `LifecycleService.swift` about the zombie-blindness limitation inherited from the app's `isAlive`. |
| `d139fa8` | **Phase 2c.2** | Lifecycle RPCs land in the engine: `services.start`, `services.stop`, `services.kill`, `services.restart`, `services.take_over`, `services.pull`, `launch_failures.list`, `launch_failures.clear`. New `LifecycleService` orchestrates posix_spawn + docker CLI through the 2c.1 foundations; project starts fire a detached launch-watcher Task and persist a spawn record. Docker / compose / unmanaged-container actions gated by `SyncDocker.daemonRunning()`; engine throws new `RPCError.dockerDaemonRequired` (-32001) when down. `ServicesService.snapshot()` now consumes `ServiceMerge.Result.deadSpawnIDs` and prunes stale records — engine is the authoritative cleanup point. 8 new lifecycle tests. |
| `41d2052` | **Phase 2c.1** follow-up | `PersistedSpawnStore` drops the redundant fixed-path `.tmp + rename(2)` dance — `Data.write(.atomic)` already gets the same atomicity with a unique-per-write temp name. Document zombie-reaping behaviour on `LifecycleSupervisor.isAlive` (`kill(pid, 0)` keeps returning 0 for unreaped zombies; no SIGCHLD handler yet). |
| `f248e8f` | **Phase 2c.1** | Engine-side lifecycle foundations: `LifecycleSupervisor` (posix_spawn + signal escalation, ported from app's `ProcessSupervisor`), `DockerActions` (async port of `DockerProbe`'s inline/compose/unmanaged action methods — no daemon start/stop yet, that's 2f), `LogRotator` (port), `EngineShell` (async port of `Shell.run`/`runCapturingStderrTail`). `PersistedSpawnStore` becomes read-write with serial-queue serialization. 10 new tests (write-side store coverage + supervisor smoke). No RPC methods yet — pure foundations. |
| `c83d494` | **Phase 2c.0** follow-up | Move the per-connection Task wrapping *inside* `ConnectionHandler` so the blocking `LineReader.readLine()` stays on the growing dispatch worker queue rather than pinning a cooperative-pool thread. Each handler call runs as a Task on the cooperative pool; the worker thread parks on a `DispatchSemaphore` for the result. |
| `b326cf2` | **Phase 2c.0** | Async dispatcher refactor. `MethodDispatcher.Handler` becomes `@Sendable (Data?) async throws -> Data`; `JSONRPCEnvelope.handle` and `ConnectionHandler.run` are async. Sync handler closures still satisfy the async slot, so `Engine.swift`'s register-sites compiled unchanged. Pure infrastructure — lifecycle (2c.1+) needs await-capable handlers. |
| `1b952a4` | **Phase 2b.2** | Merge logic + `services.snapshot` in the engine. Pure `ServiceMerge.merge(config, snapshot, spawns, …)` in MatisaCore — engine consumes it via `services.snapshot`; app's local-fallback path runs the same function. App's `ServiceStore.refresh` now ~120 lines shorter; the inline merge loop is gone. `PersistedSpawn`, `CorePaths`, `UnmanagedHeuristics`, `MatisaContainer.name`, `DockerContainer.firstHostPort`, `DockerComposeStack.matches(file:)` all live in MatisaCore. State file stays app-owned for now; engine reads it via `PersistedSpawnStore` and filters dead PIDs without writing. 28 new tests (21 merge unit tests + 7 Codable round-trips). |
| `7025fd4` | **Phase 2b.1** | Discovery snapshot in the engine. New `discovery.snapshot` RPC returns lsof + docker ps + docker compose ls + brew list + daemon flag in one call, with 1s TTL cache. App's 5 sequential probes collapse to one RPC + local fallback. |
| `d42db38` | Test gaps | Codable round-trip tests for every manual-coded type in `MatisaCore` (ServiceSpec, ServiceState, BuildSpec, UnmanagedKind, DockerSystemState, the two exposure status enums). Also envelope test for `registerRaw`. 19 new tests. |
| `cffff03` | MatisaCore extraction | Pulled shared types out of the app into a new `MatisaCore` library target. All became `public` with Codable conformance — manual coding for enums-with-payload, auto-derived for structs. App imports MatisaCore everywhere needed. |
| `1744ffd` | **Phase 2a** | Config loading moved into the engine. New `config.status` and `config.get` RPC methods. App's `ConfigLoader` tries the engine first, falls back to running bun directly when the engine's unreachable. |
| `417ef9b` | Phase 0/1 + hardening | Engine skeleton: UDS listener, JSON-RPC envelope, NDJSON framing, `engine.status` + stub `projects.list`. Plus the F-001..F-009 hardening pass: SIGPIPE ignore, JSON-RPC notification semantics, lockfile against stolen-socket, umask before bind, id type validation, batch-punt comment. 26 envelope/reader unit tests. |
| `4acb033` | App env masking | Replaced per-key sensitive heuristic with mask-everything-by-default + single "show all" toggle. (Aligns with the "names yes, values no" engine policy.) |

**Test count today: 194 passing.**

---

## Conventions to keep

- **Method names**: dotted namespaces, lowercase (`engine.status`, `services.start`, `docker.daemon.status`, `env.contexts.list`). Once a client codes against a name, renaming is a wire-break.
- **Wire types live in `MatisaCore`**. Anything that crosses the socket has a single canonical type defined there with `Codable` conformance.
- **Round-trip Codable tests** for any new wire type. Manual encode/decode is footgun-shaped — round-trip catches every typo.
- **App fallback pattern**: every app-side use of an engine RPC should `try? await EngineClient...`, then fall back to local behavior on failure. Engine going down should never break the app, only degrade it.
- **Each slice is one commit**. Each commit ends in a runnable app, verified by `swift test` (full suite) and a manual `nc -U` probe of any new method.
- **No FSEvents yet** — engine uses mtime polling for config. FSEvents lands with streaming in Phase 5.
- **No streaming yet** — clients poll. Engine has request/response only. Phase 5 adds server-pushed notifications.
- **Engine spawn-on-demand from the app** — the app `posix_spawn`s the engine binary detached at launch and on every `engineUnreachable` retry; `SMAppService` in Phase 8 will hand supervision to launchd (start-at-login, respawn-on-crash) but the lifecycle plumbing is in place.

---

## Remaining phases

**Phase 2 is complete.** Engine now owns: config, discovery, lifecycle, Caddy,
tunnels, same-network mDNS, tasks, and Docker daemon control. App is the UI
shell + local-fallback path for every subsystem.

**Phase 3 is complete.** Engine is bundled in the `.app`, auto-spawned at
launch, and stoppable via `engine.shutdown`. `EngineLauncher` is the
reusable spawn primitive (future CLI/MCP/widget will share it). Engine row
in the System group exposes status and controls. `ServiceStore` shrank
from ~1850 lines to ~1140 — Phase 3 refactors carved it into per-subsystem
clients (`CaddyClient`, `DockerDaemonClient`, `LifecycleClient`, `TaskClient`,
`ExposureClient`) and an `EngineMirror`/`EngineDispatchResult` consolidation
of the refresh-time poll path.

---

## Beyond Phase 2

Rough sketch — flesh out later.

- **Phase 4** — CLI binary. Thin RPC client. `matisa list`, `matisa start <id>`, `matisa logs <id> -f`. Stateless. Distributed inside the .app bundle with an "Install command-line tool" button (Docker Desktop / VS Code pattern).
- **Phase 5** — Streaming events. JSON-RPC server-pushed notifications on the same connection. Methods: `subscribe.services_changed`, `subscribe.logs(id)`, etc. Replaces polling. Adds FSEvents for the config file. Adds proper SSE-shaped log streaming.
- **Phase 6** — MCP server binary. Stdio JSON-RPC. Thin wrapper that maps MCP tool calls to engine RPC. Per-method exposure decisions (e.g., `get_env_value` deliberately omitted).
- **Phase 7** — Widget extension. App Group container for snapshot writes. Widget reads snapshot when engine is down; calls engine via App Intents otherwise. Tap-to-start/stop on the widget.
- **Phase 8** — `SMAppService` registration. Engine spawn already works via Phase 3's `EngineLauncher`; Phase 8 hands supervision to launchd: start-at-login, respawn-on-crash, System Settings → Login Items integration, and a "Run engine at login" toggle in the app's settings.

---

## Open decisions

- **Wire date format** — Currently using Foundation's default Date encoding (Swift reference-date numeric). Both engine and app are Swift so it round-trips. **But** if/when CLI or MCP are written in non-Swift later, this breaks. Decision: convert to ISO8601 strings before Phase 4 (CLI). Not urgent.
- **Log file ownership** — `~/Library/Logs/Matisa/<id>.log` — engine writes them now (2c). Phase 5 adds `services.logs.tail(id, n)` and `services.logs.subscribe(id)`.
- **MCP confirmation gates** — Some destructive methods (`docker.daemon.stop`, `services.kill`) probably want confirmation prompts when called via MCP. Decide policy in Phase 6.
- **Engine action errors aren't user-visible** *(2c.3 gap)* — When the engine returns a non-(-32001) RPC error (e.g. -32002 serviceNotFound, -32603 internalError) from a lifecycle call, the app currently just logs to stderr. The cleanest fix is a `engineActionErrors: [String: String]` map on `ServiceStore` (parallel to `launchFailures`) that the UI renders alongside the row, cleared on the next successful action. Pending — punted out of Phase 3; pick up before Phase 4 (CLI surfaces the same RPC errors and will want a consistent representation).
- **Zombie reaping** *(2c.1/2c.2 known limitation)* — `LifecycleSupervisor.isAlive` polls `kill(pid, 0)`, which keeps returning 0 for exited-but-unreaped children. The engine has no `SIGCHLD` handler / reaper. The launch-watcher polls `isAlive` for 10s — a quick-exit failure that becomes a zombie immediately may be missed entirely. Parity with the app's existing `ProcessSupervisor.isAlive` behaviour, so not a 2c regression, but worth fixing. Options: (a) `SIGCHLD` handler with `waitpid` reaping, (b) per-spawn `kqueue` `EVFILT_PROC` / `NOTE_EXIT` registration. (b) is the macOS-native answer.
- **Engine-side log rotation timer not wired** *(2c.1 gap)* — The engine has `LogRotator.rotateAll()` but nothing calls it on a timer; the app's `ServiceStore.startLogRotation()` is still the only driver. Either install a `DispatchSourceTimer` in `Engine.start()` that fires every 10 min, or — once Phase 8 makes the engine a true background daemon — drop the app's rotation entirely. Low priority; the file-size/age thresholds keep things bounded either way.

---

## Workflow for resuming a session

1. **Read this file top-to-bottom.**
2. `git log --oneline -10` to see what's been committed since this doc was last updated.
3. Read the relevant phase section above.
4. Check the affected source files (the phase descriptions name them).
5. Run `swift test` to confirm baseline is green.
6. Do the slice. Verify with `swift test` + a manual `nc -U` probe of any new RPC method.
7. Commit with a message like `Phase 2X.Y: <one-line summary>`.
8. **Update this plan.md** — move the slice from "Remaining phases" into "What's done", add any new gotchas / decisions discovered.

### Manual engine probe recipe

```bash
rm -f /tmp/matisa-test.sock /tmp/matisa-test.sock.lock
MATISA_SOCKET=/tmp/matisa-test.sock swift run matisa-engine &
SOCK=/tmp/matisa-test.sock
until [ -S $SOCK ]; do sleep 0.5; done

# Probe a method:
printf '{"jsonrpc":"2.0","method":"engine.status","id":1}\n' | nc -U $SOCK

# Interactive session:
socat - UNIX-CONNECT:$SOCK
# (then type JSON-RPC requests, hit enter)

# Cleanup:
pkill -f matisa-engine
```

---

## Important constraints (from CLAUDE.md)

- **Never commit without explicit instruction.**
- **Never include AI / Anthropic / Claude references in commit messages.**
- **Questions get answers, not code.** "How does X work?" is a question. "Implement X" is an instruction.
- **No documentation files unless explicitly requested.** This file is one of those exceptions — it was explicitly requested for session-handoff purposes.
