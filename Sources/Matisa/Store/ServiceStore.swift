import Foundation
import MatisaCore
import Observation
import AppKit

@MainActor
@Observable
final class ServiceStore {
    var services: [Service] = []
    var unmanaged: [Service] = []
    var isRefreshing: Bool = false
    var configError: ConfigError?
    var caddyService: CaddyServiceInfo = CaddyServiceInfo(running: false, configFile: nil)

    var engineStatus: EngineStatusInfo? = nil

    /// Docker daemon (Docker Desktop or any compatible provider) lifecycle
    /// state. Drives the System panel indicator and gates docker/compose
    /// actions — when the daemon is down, the user is prompted to start it.
    var dockerSystem: DockerSystemState = .unknown

    /// Set when a user tried to start a docker/compose service while the
    /// daemon was down. The view binds an alert to this; confirming retries
    /// the action after the daemon comes up.
    var pendingDockerPrompt: PendingDockerPrompt?

    /// Search query — drives filtered views in the UI.
    var search: String = ""

    /// Globally selected env context. Mirrors `UIState.activeEnvContext` —
    /// kept on the store so SwiftUI sees changes immediately and so callers
    /// don't have to re-read the persisted state on every spawn.
    var activeEnvContext: String? = UIStatePersistence.load().activeEnvContext

    /// When true, all collapsed-group running indicators render as a 5-bit
    /// binary readout instead of the dot-or-pill display. Toggled by clicking
    /// any one of the indicators. Transient — resets on app relaunch.
    var groupRunIndicatorBinary: Bool = false

    /// Latest crash-on-launch capture per service id. Populated by the
    /// launch-watcher in `startLocal()` when a project process dies inside
    /// its 10-second observation window. Cleared at the start of each new
    /// launch attempt for that service. Transient — never persisted; the
    /// durable record is the service's log file.
    ///
    /// Written by both the local launch-watcher (in the LocalLifecycle
    /// extension) and the engine-mirror's `launch_failures.list` apply step
    /// — internal so the extension can mutate it.
    var launchFailures: [String: LaunchFailure] = [:]

    /// Per-service ad-hoc tasks (build, scripts). Lives on the store so SwiftUI
    /// observation flows through it naturally.
    let tasks = TaskRunner()

    /// Public-tunnel (sish) state per service.
    let tunnels = TunnelManager()

    /// Same-network (mDNS) state per service.
    let mdns = MDNSPublisher()

    /// Effective tunnel/local-network settings, refreshed from the loaded config.
    private(set) var tunnelConfig: TunnelConfig = .defaults
    private(set) var localNetworkConfig: LocalNetworkConfig = .defaults

    /// Last-seen lifecycle state per service id, used to detect transitions
    /// (e.g. running → stopped) so we can auto-tear-down the public tunnel.
    private var lastSeenStateByID: [String: ServiceState] = [:]

    let configLoader = ConfigLoader()
    private let engineMirror = EngineMirror()
    private let lifecycleClient = LifecycleClient()
    private let dockerDaemonClient = DockerDaemonClient()
    private let caddyClient = CaddyClient()
    private let exposureClient = ExposureClient()
    private let taskClient = TaskClient()
    private var refreshTask: Task<Void, Never>?
    private var rotateTask: Task<Void, Never>?
    // Local-fallback Caddy regen+reload debounce — owned here so SwiftUI
    // observation lives on the store, written by `scheduleCaddyRegenLocal`
    // in the Local extension.
    var caddyReloadTask: Task<Void, Never>?
    /// In-flight Docker Desktop start. Cancelled by the sheet's Cancel /
    /// dismiss — see `cancelDockerStartInFlight()`. Written by the local
    /// daemon-control fallbacks in the Local extension.
    var dockerStartTask: Task<Void, Never>?
    private var pasteboard: NSPasteboard { .general }

    /// Centralised stderr log for engine rpcError responses on a named
    /// action. Same format the inlined catches used pre-3 so log scrapes
    /// stay valid. A dedicated `engineActionErrors` UI surface is pending.
    private static func logEngineRpcError(_ method: String, _ message: String) {
        FileHandle.standardError.write(
            Data("ServiceStore: engine rpcError on \(method): \(message)\n".utf8)
        )
    }

    init() {}

    // MARK: - Bootstrap

    func bootstrap() async {
        await refresh()
        startPolling(intervalSeconds: 4)
        startLogRotation()
    }

    func startPolling(intervalSeconds: TimeInterval) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(intervalSeconds * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    func stopPolling() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    private func startLogRotation() {
        rotateTask?.cancel()
        rotateTask = Task.detached(priority: .utility) {
            while !Task.isCancelled {
                LogRotator.rotateAll()
                // Every 10 minutes is plenty.
                try? await Task.sleep(nanoseconds: 10 * 60 * 1_000_000_000)
            }
        }
    }

    // MARK: - Discovery

    func refresh() async {
        if isRefreshing { return }
        isRefreshing = true
        defer { isRefreshing = false }

        // Config — still loaded app-side for caddy/tunnel/local-network UI
        // state, which the engine doesn't own until Phases 2d/2e.
        let config: AppConfig
        do {
            config = try await configLoader.load()
            self.configError = nil
        } catch let err as ConfigError {
            self.configError = err
            self.services = []
            self.unmanaged = []
            return
        } catch {
            self.configError = .parseFailed(String(describing: error))
            self.services = []
            self.unmanaged = []
            return
        }

        // Discovery — still gathered for brewServices (the caddy indicator)
        // and as the input for the local-merge fallback path below. Hits the
        // engine's cached snapshot when reachable.
        let inputs = await gatherDiscovery()

        // Phase 3: refresh-time RPC polling is consolidated in EngineMirror.
        // The mirror returns an optional-per-field Snapshot — `services` nil
        // means engine-unreachable and we run the local merge fallback; other
        // nil fields mean "engine answered services but failed this slice;
        // leave the local mirror untouched".
        let paneVisibleIDs = paneVisibleTaskServiceIDs()
        let mirror = await engineMirror.pull(
            paneVisibleTaskServiceIDs: paneVisibleIDs
        )

        let managed: [Service]
        let unmanagedList: [Service]
        let dockerDaemonRunning: Bool
        let engineReachable: Bool
        if let snap = mirror.services {
            managed = snap.managed
            unmanagedList = snap.unmanaged
            dockerDaemonRunning = snap.dockerDaemonRunning
            engineReachable = true
            // Engine is the authority on launch failures when reachable —
            // replace the local map wholesale. Best-effort: on transport
            // failure for this slice alone, leave the existing map intact
            // (next tick will retry).
            if let failures = mirror.launchFailures {
                self.launchFailures = failures
            }
        } else {
            // Local-fallback path: don't touch `launchFailures` — the local
            // watcher's writes are the authority here.
            let result = await localMerge(config: config, snapshot: inputs)
            managed = result.managed
            unmanagedList = result.unmanaged
            dockerDaemonRunning = inputs.dockerDaemonRunning
            engineReachable = false
        }

        // Phase 2f: engine owns the Docker daemon state machine. When
        // reachable, mirror its view — the engine reconciles `.starting` /
        // `.startFailed` against the live probe internally.
        // When the engine isn't reachable, fall back to the pre-2f
        // local state machine: only let the probe override the indicator
        // when we're not in a deliberate UI state.
        if engineReachable, let engineState = mirror.dockerSystem {
            if engineState == .unknown {
                // Engine hasn't reconciled its state machine yet (boots at
                // .unknown). Fall back to the live probe rather than render
                // a stuck "Checking…" — the engine's reconcile usually beats
                // us on the next tick anyway.
                dockerSystem = dockerDaemonRunning ? .running : .stopped
            } else {
                // Guard against a click-then-refresh race: if the user just
                // pressed Start (locally marking `.starting`) while a refresh
                // tick had already read `.stopped` from the engine pre-click,
                // a stale write here would flicker the UI back to `.stopped`
                // until the next 4s tick. The optimistic local `.starting`
                // wins until the engine catches up to it.
                let staleStoppedDuringClick =
                    dockerSystem.isStarting && engineState == .stopped
                if !staleStoppedDuringClick {
                    dockerSystem = engineState
                }
            }
        } else {
            if !dockerSystem.isStarting && !dockerSystem.isStartFailed {
                dockerSystem = dockerDaemonRunning ? .running : .stopped
            } else if dockerSystem.isStartFailed {
                // Daemon may have come up some other way (user opened Docker
                // Desktop manually) — let that override the stale failure label.
                if dockerDaemonRunning {
                    dockerSystem = .running
                }
            }
        }

        // Engine status — mirrored from engine.status when reachable, cleared
        // when not. Mirrors the `launchFailures` pattern: a transient nil for
        // this slice alone (services.snapshot OK but engine.status call blipped)
        // is treated as "leave the local value intact for one tick" so the
        // Engine row in the System group doesn't flicker on a momentary glitch.
        if engineReachable {
            if let info = mirror.engine {
                self.engineStatus = info
            }
            // else: leave existing engineStatus; next tick will recover.
        } else {
            self.engineStatus = nil
        }

        // Phase 2d: the engine owns the Caddy status snapshot when reachable.
        // Fall back to deriving it from brewServices + config on the local
        // path so a missing engine doesn't blank the indicator.
        if engineReachable, let info = mirror.caddy {
            self.caddyService = info
        } else {
            let caddy = inputs.brewServices.first(where: { $0.name == "caddy" })
            self.caddyService = CaddyServiceInfo(
                running: caddy?.isRunning ?? false,
                configFile: config.caddyfile
            )
        }
        // Tunnel / local-network — app-owned until Phase 2e.
        self.tunnelConfig = config.tunnel
        self.localNetworkConfig = config.localNetwork

        self.services = managed
        self.unmanaged = unmanagedList

        // Phase 2e.3: engine owns the ad-hoc task slots. The mirror has
        // already fetched `tasks.list` for every pane-visible service id;
        // apply the per-id results. On engine-unreachable the mirror returns
        // an empty map and the local TaskRunner remains authoritative.
        for (id, slots) in mirror.tasksByServiceID {
            tasks.replaceSlotsFromEngine(serviceID: id, wire: slots)
        }

        // Phase 2e.1: mirror tunnel statuses from the engine when reachable.
        // The engine's `reconcileAfterSnapshot` already tore down tunnels for
        // services that just stopped (inside `services.snapshot` before the
        // response was built), so the auto-teardown block below only runs in
        // the local-fallback path.
        if engineReachable, let statuses = mirror.publicTunnels {
            tunnels.replaceStatusesFromEngine(statuses)
        }

        // Phase 2e.2: mirror same-network (mDNS) statuses from the engine.
        // Same preserve-locally-spawned-by-Process-liveness shape as the
        // tunnel mirror — entries the local fallback created during an
        // engine-unreachable window survive. Engine doesn't auto-teardown on
        // service stop (visitors get a Caddy 502 rather than a DNS error),
        // so there's no equivalent of the tunnel teardown block to skip.
        if engineReachable, let statuses = mirror.sameNetwork {
            mdns.replaceStatusesFromEngine(statuses)
        }

        // After the new states are committed, look at lifecycle transitions
        // to auto-tear-down public tunnels for services that just stopped.
        // Same-network registrations stay up — visitors get a Caddy 502
        // rather than a DNS error, which is more diagnosable.
        //
        // Engine-reachable path skips this — the engine's
        // `TunnelService.reconcileAfterSnapshot` is the authority.
        if !engineReachable {
            for svc in managed {
                let prev = lastSeenStateByID[svc.id]
                let nowRunning = svc.state.isRunning
                let wasRunning = prev?.isRunning ?? false
                if wasRunning && !nowRunning {
                    if tunnels.status(for: svc.id).isActive {
                        tunnels.stopBecauseServiceStopped(serviceID: svc.id)
                    }
                }
                lastSeenStateByID[svc.id] = svc.state
            }
        }
    }

    /// Set of service ids whose build or script pane is currently visible —
    /// fed to `EngineMirror.pull` so it only fetches `tasks.list` for those.
    /// Iterating the previous `services` (rather than the new managed list)
    /// is fine: visibility is keyed by service id and persists across
    /// refreshes; if a brand-new id has a visible pane this tick, the next
    /// 4s tick picks it up. Matches the pre-3 behaviour where the task
    /// fetch ran after `self.services` was already replaced.
    private func paneVisibleTaskServiceIDs() -> Set<String> {
        var out: Set<String> = []
        for svc in services {
            if tasks.isPaneVisible(svc.id, .build) || tasks.isPaneVisible(svc.id, .script) {
                out.insert(svc.id)
            }
        }
        return out
    }

    // MARK: - Public actions

    func service(id: String) -> Service? {
        services.first(where: { $0.id == id }) ?? unmanaged.first(where: { $0.id == id })
    }

    // MARK: - Exposure (public tunnel + same-network)

    /// Combined exposure state for a service. Read by the UI.
    func exposure(for service: Service) -> ServiceExposure {
        ServiceExposure(
            publicTunnel: tunnels.status(for: service.id),
            sameNetwork: mdns.status(for: service.id)
        )
    }

    /// Map of service id → exposure for every service that has any active
    /// exposure. Used by the Caddy generator and the sidebar row indicators.
    var activeExposuresByServiceID: [String: ServiceExposure] {
        var out: [String: ServiceExposure] = [:]
        for svc in services {
            let e = exposure(for: svc)
            if e.hasAnyActive { out[svc.id] = e }
        }
        return out
    }

    /// Toggle the public tunnel for a service. Engine-first; the engine's
    /// `exposure.public_tunnel.toggle` handles all the gating (service
    /// running, ssh key present, port available) so the app side doesn't
    /// need to preflight. On engine-unreachable, runs the same checks +
    /// local TunnelManager calls as pre-2e.1.
    func togglePublicTunnel(_ service: Service) {
        Task {
            switch await exposureClient.togglePublicTunnel(serviceID: service.id) {
            case .ok:
                return
            case .dockerDaemonRequired:
                // Exposure RPCs don't currently surface -32001; treat the
                // same as an unexpected rpcError so behaviour stays
                // identical to pre-3.
                return
            case .rpcError(let msg):
                Self.logEngineRpcError("exposure.public_tunnel.toggle", msg)
                return
            case .engineUnreachable:
                togglePublicTunnelLocal(service)
            }
        }
    }

    /// Toggle same-network exposure for a service. Engine-first; the
    /// engine's `exposure.same_network.toggle` handles the dns-sd lifecycle
    /// and fires its own internal Caddy regen+reload. On engine-unreachable,
    /// runs the local MDNSPublisher path with an app-side debounce so we
    /// still pick up the Caddyfile change.
    func toggleSameNetwork(_ service: Service) {
        Task {
            switch await exposureClient.toggleSameNetwork(serviceID: service.id) {
            case .ok:
                return
            case .dockerDaemonRequired:
                // Exposure RPCs don't currently surface -32001; treat the
                // same as an unexpected rpcError so behaviour stays
                // identical to pre-3.
                return
            case .rpcError(let msg):
                Self.logEngineRpcError("exposure.same_network.toggle", msg)
                return
            case .engineUnreachable:
                toggleSameNetworkLocal(service)
            }
        }
    }

    // MARK: - Env contexts

    /// True when at least one configured service declares an `env` block.
    /// The pickers hide entirely when this is false.
    var hasAnyEnvConfigured: Bool {
        services.contains(where: { $0.spec.env?.isEmpty == false })
    }

    /// Union of declared context names across all services, in first-seen
    /// order. Drives the picker's option list.
    var availableEnvContexts: [String] {
        var seen: Set<String> = []
        var result: [String] = []
        for svc in services {
            for name in svc.spec.env?.contextNames ?? [] {
                if seen.insert(name).inserted {
                    result.append(name)
                }
            }
        }
        return result
    }

    /// Set the active context (or `nil` for "none") and persist it.
    func setActiveEnvContext(_ name: String?) {
        activeEnvContext = name
        var state = UIStatePersistence.load()
        state.activeEnvContext = name
        UIStatePersistence.save(state)
    }

    func perform(_ action: ServiceAction, on service: Service) async {
        // The pre-emptive daemon probe used to live here; now the engine's
        // -32001 (dockerDaemonRequired) drives the prompt when the engine is
        // reachable, and the *Local fallback path runs its own probe when
        // the engine is unreachable.
        //
        // We DO still short-circuit while Docker Desktop is mid-boot: firing
        // a docker-using action through the engine in that window either
        // races the start sheet (engine returns -32001 and stomps the
        // already-up `pendingDockerPrompt`) or non-deterministically
        // succeeds depending on when the daemon comes ready. Same gate the
        // pre-2c.3 perform() had.
        if Self.actionNeedsDocker(action, service: service), dockerSystem.isStarting {
            return
        }

        switch action {
        case .start:           await start(service)
        case .stop:            await stop(service)
        case .kill:            await kill(service)
        case .restart:         await restart(service)
        case .takeOver:        await takeOver(service)
        case .openURL:         openURL(service)
        case .copyURL:         copyURL(service)
        case .revealInFinder:  revealInFinder(service)
        case .revealInEditor:  revealInEditor(service)
        case .revealInTerminal: revealInTerminal(service)
        case .pull:            await pull(service)
        case .execShell:       execShell(service)
        case .openCaddyfile:   openCaddyfile()
        case .validateCaddy:   await validateCaddy()
        case .reloadCaddy:     await reloadCaddy()
        }
        await refresh()
    }

    // MARK: - Lifecycle dispatchers (engine-first, local fallback)

    /// Engine-first lifecycle dispatch. On success, the engine owns the
    /// spawn record, the launch watcher, and the launch-failure tracker —
    /// the next `refresh()` pulls the new state via `services.snapshot`.
    /// On transport failure (engine unreachable), falls through to the local
    /// implementation in `*Local`. On a deliberate engine-side error
    /// (-32001 dockerDaemonRequired, -32002 serviceNotFound, etc.) we honour
    /// the engine's "no" rather than retry locally — same UI prompt for the
    /// docker case, an error state for the rest.
    private func start(_ service: Service) async {
        await dispatchLifecycle(
            service: service,
            action: .start,
            engineCall: { await self.lifecycleClient.start(serviceID: service.id) },
            local: { await self.startLocal(service) }
        )
    }

    private func stop(_ service: Service) async {
        await dispatchLifecycle(
            service: service,
            action: .stop,
            engineCall: { await self.lifecycleClient.stop(serviceID: service.id) },
            local: { await self.stopLocal(service) }
        )
    }

    private func kill(_ service: Service) async {
        await dispatchLifecycle(
            service: service,
            action: .kill,
            engineCall: { await self.lifecycleClient.kill(serviceID: service.id) },
            local: { await self.killLocal(service) }
        )
    }

    private func restart(_ service: Service) async {
        await dispatchLifecycle(
            service: service,
            action: .restart,
            engineCall: { await self.lifecycleClient.restart(serviceID: service.id) },
            local: { await self.restartLocal(service) }
        )
    }

    private func takeOver(_ service: Service) async {
        await dispatchLifecycle(
            service: service,
            action: .takeOver,
            engineCall: { await self.lifecycleClient.takeOver(serviceID: service.id) },
            local: { await self.takeOverLocal(service) }
        )
    }

    private func pull(_ service: Service) async {
        await dispatchLifecycle(
            service: service,
            action: .pull,
            engineCall: { await self.lifecycleClient.pull(serviceID: service.id) },
            local: { await self.pullLocal(service) }
        )
    }

    /// Shared four-arm switch for every lifecycle action. The pre-3 inline
    /// shape was: try the RPC → on -32001 surface a docker prompt and bail
    /// → on any other rpcError log to stderr and bail (the trailing
    /// `refresh()` would overwrite a transient `.error` flash before the
    /// user could see it) → on transport failure fall through to local.
    /// Centralising it here keeps the per-action wrappers a one-liner.
    private func dispatchLifecycle(
        service: Service,
        action: ServiceAction,
        engineCall: () async -> EngineDispatchResult,
        local: () async -> Void
    ) async {
        switch await engineCall() {
        case .ok:
            return
        case .dockerDaemonRequired:
            dockerSystem = .stopped
            pendingDockerPrompt = PendingDockerPrompt(
                serviceID: service.id,
                serviceName: service.name,
                action: action
            )
        case .rpcError(let msg):
            // Engine deliberately said no (e.g. -32002 serviceNotFound,
            // -32603 internal). Don't write a transient `.error` state —
            // the trailing refresh() would overwrite it within milliseconds
            // with the engine's actual snapshot value, so the user only
            // sees a flicker. Log for now; a dedicated `engineActionErrors`
            // surface for the UI is pending (tracked in plan.md).
            Self.logEngineRpcError("services.\(action)", msg)
        case .engineUnreachable:
            await local()
        }
    }

    // MARK: - Build / scripts
    //
    // Engine-first dispatch: `runBuild` and `runScript` route through
    // `tasks.start` on the engine; on engine-unreachable they fall through
    // to the local `TaskRunner`. The UI's stop / clear / closePane buttons
    // call into `stopTask`, `clearTask`, and `closeTaskPane` below, which
    // do the same engine-first dance. When the engine accepts a `tasks.start`,
    // the wrapper writes a placeholder `.running` slot into the local runner
    // so `isPaneVisible` returns true; the next `refresh()` tick polls
    // `tasks.list(id)` and mirrors the engine's real state into the slot.

    /// Run the configured build for a service. `name` selects which build
    /// command when the spec is `BuildSpec.multi`; ignored for `.single`.
    /// No-op when no build is configured or one is already running.
    func runBuild(_ service: Service, named name: String? = nil) {
        guard let build = service.spec.build else { return }
        let chosen: NamedCommand
        switch build {
        case .single(let cmd):
            chosen = NamedCommand(name: "build", command: cmd)
        case .multi(let commands):
            if let name, let match = commands.first(where: { $0.name == name }) {
                chosen = match
            } else if let first = commands.first {
                chosen = first
            } else {
                return
            }
        }
        startTask(
            service: service,
            kind: .build,
            localKind: .build,
            chosen: chosen
        )
    }

    /// Run a named script for a service. No-op if the name isn't configured
    /// or a script is already running for this service.
    func runScript(_ service: Service, named name: String) {
        guard let match = service.spec.scripts.first(where: { $0.name == name }) else { return }
        startTask(
            service: service,
            kind: .script,
            localKind: .script,
            chosen: match
        )
    }

    /// Cancel the running task in `(service, kind)`. Engine-first; falls back
    /// to the local TaskRunner.stop on engine-unreachable.
    func stopTask(_ service: Service, kind: TaskRunner.TaskKind) {
        let wireKind = Self.wireKind(kind)
        Task {
            switch await taskClient.cancel(serviceID: service.id, kind: wireKind) {
            case .ok, .rpcError, .dockerDaemonRequired:
                // Engine handled it (success) or deliberately refused
                // (rpcError). Either way there's nothing to fall back to.
                // tasks.* don't surface -32001; treat as a refusal.
                return
            case .engineUnreachable:
                tasks.stop(serviceID: service.id, kind: kind)
            }
        }
    }

    /// Clear the output buffer for `(service, kind)` without stopping. Engine
    /// returns success even when no slot exists, so we always issue the RPC
    /// and only fall back on transport failure.
    func clearTask(_ service: Service, kind: TaskRunner.TaskKind) {
        let wireKind = Self.wireKind(kind)
        // Optimistic local clear so the UI updates immediately; the next
        // refresh will overwrite from the engine's view anyway. Matches the
        // app's pre-2e.3 latency.
        tasks.clear(serviceID: service.id, kind: kind)
        Task {
            await taskClient.clear(serviceID: service.id, kind: wireKind)
        }
    }

    /// Close the pane for `(service, kind)`. No-op while the task is still
    /// running. Engine-first; falls back to local on engine-unreachable.
    func closeTaskPane(_ service: Service, kind: TaskRunner.TaskKind) {
        let wireKind = Self.wireKind(kind)
        // Optimistic local close so the UI hides the pane immediately. If the
        // engine still considers it running (race), the next refresh will
        // bring back the running slot.
        tasks.closePane(serviceID: service.id, kind: kind)
        Task {
            await taskClient.closePane(serviceID: service.id, kind: wireKind)
        }
    }

    /// Shared engine-first start path. On engine acceptance, writes a
    /// placeholder `.running` slot into the local runner so `isPaneVisible`
    /// flips to true and the next refresh tick starts polling `tasks.list`.
    /// On engine-unreachable, drives the local TaskRunner directly.
    private func startTask(
        service: Service,
        kind: MatisaCore.TaskKind,
        localKind: TaskRunner.TaskKind,
        chosen: NamedCommand
    ) {
        // Skip if a task of the same kind is already running locally. Matches
        // `TaskRunner.start`'s same-shape guard.
        if tasks.slot(service.id, localKind).state.isRunning { return }

        let cwd = service.spec.workingDirectory
        let env = service.spec.env?.effective(activeContext: activeEnvContext) ?? [:]
        let chosenName = chosen.name
        Task { @MainActor in
            let result = await taskClient.start(
                serviceID: service.id,
                kind: kind,
                name: chosen.name,
                command: chosen.command,
                cwd: cwd,
                extraEnv: env
            )
            switch result {
            case .ok:
                // Engine accepted. Write a placeholder so the next refresh
                // tick sees a visible pane and starts polling.
                tasks.writeEnginePlaceholder(
                    serviceID: service.id,
                    kind: localKind,
                    name: chosenName
                )
            case .rpcError, .dockerDaemonRequired:
                // Engine deliberately refused; nothing to fall back to.
                // tasks.* don't surface -32001; treat as a refusal.
                return
            case .engineUnreachable:
                tasks.start(
                    serviceID: service.id,
                    kind: localKind,
                    name: chosen.name,
                    command: chosen.command,
                    cwd: cwd,
                    extraEnv: env
                )
            }
        }
    }

    private static func wireKind(_ k: TaskRunner.TaskKind) -> MatisaCore.TaskKind {
        switch k {
        case .build:  return .build
        case .script: return .script
        }
    }

    /// Lifecycle/state-changing actions that go through the docker CLI. Read
    /// actions (URL open, copy, etc.) and project-only kinds skip the gate.
    /// Unmanaged services are split: container actions need docker, process
    /// actions don't. Internal so the local-fallback extension's
    /// `ensureDockerForLocal` can call it from another file.
    static func actionNeedsDocker(_ action: ServiceAction, service: Service) -> Bool {
        let dockerActions: Set<ServiceAction> = [.start, .stop, .restart, .pull, .takeOver, .kill]
        switch service.spec {
        case .docker, .compose:
            return dockerActions.contains(action)
        case .project:
            return false
        case .unmanaged(let f):
            switch f.kind {
            case .container:
                return [.start, .stop, .kill].contains(action)
            case .process:
                return false
            }
        }
    }

    // MARK: - Docker daemon control
    //
    // Phase 2f: the engine owns the daemon state machine via
    // `docker.daemon.*` RPCs. Each method below tries the engine first and
    // falls back to the local `*Local` helper on engine-unreachable. The
    // `dockerSystem` field on the store remains as a mirror of the engine's
    // view (or as authoritative when running on the local-fallback path).

    /// Quit Docker Desktop. The System panel calls this; doesn't tear down
    /// running services beyond what Docker itself does on quit.
    func performDockerStop() async {
        switch await dockerDaemonClient.stop() {
        case .ok:
            // Optimistic mirror — refresh() will reconcile from
            // docker.daemon.status. The engine sets `.stopped` once the
            // AppleScript returns.
            dockerSystem = .stopped
            await refresh()
        case .rpcError(let msg):
            Self.logEngineRpcError("docker.daemon.stop", msg)
        case .dockerDaemonRequired:
            // docker.daemon.* don't surface -32001; treat as a refusal.
            return
        case .engineUnreachable:
            await performDockerStopLocal()
        }
    }

    /// Launch Docker Desktop and poll until the daemon is reachable. Drives
    /// the System panel start button; doesn't replay any pending action.
    func performDockerStart() async {
        guard !dockerSystem.isStarting else { return }
        switch await dockerDaemonClient.start() {
        case .ok:
            // Optimistic mirror — refresh() and the periodic poll will
            // overwrite once the engine's state machine resolves. We set
            // `.starting` so the System panel indicator and the
            // "Starting Docker Desktop…" sheet appear immediately.
            dockerSystem = .starting
            // Wait for the engine state machine to settle. Same shape as
            // the pre-2f path: we don't return until `dockerSystem` has
            // moved off `.starting`, so callers can chain a `refresh()`
            // confidently.
            await awaitEngineDockerSettled()
            await refresh()
        case .rpcError(let msg):
            Self.logEngineRpcError("docker.daemon.start", msg)
        case .dockerDaemonRequired:
            return
        case .engineUnreachable:
            await performDockerStartLocal()
        }
    }

    /// User confirmed the alert: start Docker, then retry the gated action
    /// against the original service. Bails (with a `startFailed` state) if
    /// the daemon never comes up, and silently no-ops if cancelled.
    func confirmDockerStart() async {
        guard let prompt = pendingDockerPrompt else { return }
        pendingDockerPrompt = nil
        switch await dockerDaemonClient.start() {
        case .ok:
            dockerSystem = .starting
            await awaitEngineDockerSettled()
            // Replay only if the daemon actually came up. If the engine
            // cancelled or timed out, `dockerSystem` is `.stopped` or
            // `.startFailed`.
            guard case .running = dockerSystem else { return }
            guard let service = self.service(id: prompt.serviceID) else { return }
            await perform(prompt.action, on: service)
        case .rpcError(let msg):
            Self.logEngineRpcError("docker.daemon.start", msg)
        case .dockerDaemonRequired:
            return
        case .engineUnreachable:
            await confirmDockerStartLocal(prompt: prompt)
        }
    }

    /// User dismissed the alert without starting Docker.
    func cancelDockerStart() {
        pendingDockerPrompt = nil
    }

    /// User dismissed the "Starting Docker Desktop…" sheet (Cancel button,
    /// Esc, or click-outside). Halts the in-flight `awaitDaemonReady` and
    /// fires a graceful AppleScript quit at Docker Desktop in the background.
    /// The graceful quit can hang while Docker is still booting — we don't
    /// wait for it; the user gets their UI back immediately and the next
    /// refresh tick reconciles whatever Docker actually does. We never
    /// escalate to `killall`, which is documented to risk Docker.raw
    /// corruption mid-boot.
    func cancelDockerStartInFlight() {
        guard dockerSystem.isStarting else { return }
        // Best-effort engine cancel — fire-and-forget. Local cleanup runs
        // unconditionally; the engine's cancel_start is idempotent with it
        // (both transition to .stopped and quit Docker in the background).
        Task { _ = await dockerDaemonClient.cancelStart() }
        dockerStartTask?.cancel()
        dockerStartTask = nil
        pendingDockerPrompt = nil
        dockerSystem = .stopped
        Task.detached { await DockerProbe.stopDockerDesktop() }
    }

    /// Acknowledge a `startFailed` state — clears the indicator so the user
    /// can try again.
    func clearDockerStartFailure() {
        // Best-effort engine clear — fire-and-forget. Local mirror update
        // runs unconditionally so the UI hides the failure label immediately.
        Task { _ = await dockerDaemonClient.clearFailure() }
        if case .startFailed = dockerSystem {
            dockerSystem = .stopped
        }
    }

    /// Block until the engine's Docker daemon state moves off `.starting`.
    /// Polls `docker.daemon.status` every 500ms with a 70s ceiling (10s wider
    /// than the engine's own 60s readiness timeout, so a healthy timeout
    /// always resolves before this gives up). On transport failure during
    /// the poll, returns early so callers don't hang on an engine that
    /// dropped out mid-start.
    private func awaitEngineDockerSettled() async {
        let deadline = Date().addingTimeInterval(70)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let s = await dockerDaemonClient.status() else {
                // Transport failure during the poll — bail rather than hang.
                return
            }
            dockerSystem = s
            if !s.isStarting { return }
        }
    }

    func performEngineStart() async {
        do {
            _ = try await EngineLauncher.ensureRunning(
                socketPath: EngineClient.defaultSocketPath()
            )
        } catch {
            FileHandle.standardError.write(
                Data("performEngineStart: \(error)\n".utf8)
            )
        }
        // Always refresh — even on spawn failure, the engine may have come
        // up after a slow start, or some other state may have changed.
        await refresh()
    }

    func performEngineStop() async {
        do {
            try await EngineClient.shared.shutdown()
        } catch {
            FileHandle.standardError.write(
                Data("performEngineStop: \(error)\n".utf8)
            )
        }
        // Clear the mirror immediately — the row should reflect the user's
        // intent right away rather than waiting on the 4s refresh poller.
        self.engineStatus = nil

        // The shutdown handler acks before raising SIGTERM (~100ms delay),
        // so the engine is briefly still reachable. Wait until the socket
        // actually goes dark (or a short ceiling, in case shutdown failed)
        // before refreshing — otherwise the refresh restores engineStatus
        // and the row flickers Stopped → Running → Stopped.
        for _ in 0..<20 where await EngineClient.shared.isReachable() {
            try? await Task.sleep(nanoseconds: 50_000_000) // 50ms × 20 = 1s ceiling
        }

        await refresh()
    }

    func performCaddy(_ action: CaddyAction) async {
        switch action {
        case .start:           await caddyStart()
        case .stop:            await caddyStop()
        case .restart:         await caddyRestart()
        case .reload:          await reloadCaddy()
        case .validate:        await validateCaddy()
        case .openCaddyfile:   openCaddyfile()
        case .revealCaddyfile: revealCaddyfile()
        case .regenerate:      await regenerateCaddyfile()
        }
        await refresh()
    }

    // MARK: - Caddy lifecycle (engine-first, local fallback)

    /// Engine-first start/stop/restart for the brew-managed caddy service.
    /// On transport failure (engine unreachable) falls back to the local
    /// `BrewServices` path so the UI keeps working without the engine. On a
    /// deliberate RPC error we log and return — the trailing refresh will
    /// reconcile the indicator off `caddy.status`.
    private func caddyStart() async {
        switch await caddyClient.start() {
        case .ok, .dockerDaemonRequired:
            // caddy.* don't surface -32001 today; treat as success.
            return
        case .rpcError(let msg):
            Self.logEngineRpcError("caddy.start", msg)
        case .engineUnreachable:
            try? await BrewServices.start("caddy")
        }
    }

    private func caddyStop() async {
        switch await caddyClient.stop() {
        case .ok, .dockerDaemonRequired:
            return
        case .rpcError(let msg):
            Self.logEngineRpcError("caddy.stop", msg)
        case .engineUnreachable:
            try? await BrewServices.stop("caddy")
        }
    }

    private func caddyRestart() async {
        switch await caddyClient.restart() {
        case .ok, .dockerDaemonRequired:
            return
        case .rpcError(let msg):
            Self.logEngineRpcError("caddy.restart", msg)
        case .engineUnreachable:
            try? await BrewServices.restart("caddy")
        }
    }

    // MARK: - Launch-failure clear (engine-first)

    /// Drop the launch-failure capture for a service — invoked when the user
    /// dismisses the detail-view banner. Doesn't change the service state.
    /// Best-effort engine clear so the next refresh doesn't reanimate the
    /// banner from `launch_failures.list`; the local entry is dropped
    /// regardless so the UI hides immediately.
    func clearLaunchFailure(for serviceID: String) {
        launchFailures.removeValue(forKey: serviceID)
        Task { _ = await lifecycleClient.clearLaunchFailure(serviceID: serviceID) }
    }

    private func execShell(_ service: Service) {
        let containerTarget: String
        switch service.spec {
        case .docker(let f): containerTarget = DockerProbe.inlineContainerName(f.name)
        case .compose(let f): containerTarget = f.name
        default: return
        }
        let appleScript = #"""
        tell application "Terminal"
            do script "docker exec -it \#(containerTarget) sh"
            activate
        end tell
        """#
        runOsascript(appleScript)
    }

    // MARK: - Reveal helpers

    private func openURL(_ service: Service) {
        guard let host = service.spec.primaryURL,
              let url = URL(string: "http://\(host)") else { return }
        NSWorkspace.shared.open(url)
    }

    private func copyURL(_ service: Service) {
        guard let host = service.spec.primaryURL else { return }
        pasteboard.clearContents()
        pasteboard.setString("http://\(host)", forType: .string)
    }

    private func revealInFinder(_ service: Service) {
        let target: URL?
        switch service.spec {
        case .project(let f): target = f.path
        case .compose(let f): target = f.file.deletingLastPathComponent()
        default: target = nil
        }
        guard let target else { return }
        NSWorkspace.shared.activateFileViewerSelecting([target])
    }

    private func revealInEditor(_ service: Service) {
        guard case .project(let f) = service.spec else { return }
        for editor in ["cursor", "code"] {
            if let bin = Shell.which(editor) {
                Task.detached {
                    try? await Shell.run(executable: bin, arguments: [f.path.path])
                }
                return
            }
        }
        NSWorkspace.shared.open(f.path)
    }

    private func revealInTerminal(_ service: Service) {
        let dir: URL?
        switch service.spec {
        case .project(let f): dir = f.path
        case .compose(let f): dir = f.file.deletingLastPathComponent()
        default: dir = nil
        }
        guard let dir else { return }
        let appleScript = #"""
        tell application "Terminal"
            do script "cd \#(dir.path)"
            activate
        end tell
        """#
        runOsascript(appleScript)
    }

    // MARK: - Caddy

    private func openCaddyfile() {
        guard let path = caddyService.configFile else { return }
        for editor in ["cursor", "code"] {
            if let bin = Shell.which(editor) {
                Task.detached { try? await Shell.run(executable: bin, arguments: [path.path]) }
                return
            }
        }
        NSWorkspace.shared.open(path)
    }

    private func revealCaddyfile() {
        guard let path = caddyService.configFile else { return }
        NSWorkspace.shared.activateFileViewerSelecting([path])
    }

    private func validateCaddy() async {
        switch await caddyClient.validate() {
        case .ok, .dockerDaemonRequired:
            return
        case .rpcError(let msg):
            Self.logEngineRpcError("caddy.validate", msg)
        case .engineUnreachable:
            await validateCaddyLocal()
        }
    }

    private func reloadCaddy() async {
        switch await caddyClient.reload() {
        case .ok, .dockerDaemonRequired:
            return
        case .rpcError(let msg):
            Self.logEngineRpcError("caddy.reload", msg)
        case .engineUnreachable:
            await reloadCaddyLocal()
        }
    }

    private func regenerateCaddyfile() async {
        // Phase 2e.2: the engine's CaddyService.loadExposures now combines
        // TunnelService.list() and MDNSService.list(), so engine-rendered
        // Caddyfiles contain the runtime exposure blocks. Route through the
        // engine first; fall back to the local renderer when the engine is
        // unreachable (we still hold the authoritative exposures map in
        // that branch).
        switch await caddyClient.regenerate() {
        case .ok, .dockerDaemonRequired:
            return
        case .rpcError(let msg):
            Self.logEngineRpcError("caddy.regenerate", msg)
        case .engineUnreachable:
            await regenerateCaddyfileLocal()
        }
    }

    // MARK: - Helpers

    /// Internal so the local-fallback extensions can mark transitions
    /// (e.g. `.starting`, `.stopped`, `.error(...)`) on the observable
    /// service array. Pre-3 this was `private`; bumped to internal when the
    /// `*Local` bodies moved into separate files under `Sources/Matisa/Local/`.
    func markState(_ id: String, _ state: ServiceState) {
        if let idx = services.firstIndex(where: { $0.id == id }) {
            services[idx].state = state
        }
    }

    private func runOsascript(_ script: String) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", script]
        try? task.run()
    }
}

enum CaddyAction: Hashable, Sendable {
    case start
    case stop
    case restart
    case reload
    case validate
    case openCaddyfile
    case revealCaddyfile
    case regenerate
}
