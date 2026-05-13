import Foundation
import MatisaCore
import Observation
import AppKit

@MainActor
@Observable
final class ServiceStore {
    var services: [Service] = []
    var unmanaged: [Service] = []
    var lastRefresh: Date?
    var isRefreshing: Bool = false
    var configError: ConfigError?
    var caddyService: CaddyServiceInfo = CaddyServiceInfo(running: false, configFile: nil)

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
    /// launch-watcher in `start()` when a project process dies inside its
    /// 10-second observation window. Cleared at the start of each new launch
    /// attempt for that service. Transient — never persisted; the durable
    /// record is the service's log file.
    private(set) var launchFailures: [String: LaunchFailure] = [:]

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

    private let configLoader = ConfigLoader()
    private var refreshTask: Task<Void, Never>?
    private var rotateTask: Task<Void, Never>?
    private var caddyReloadTask: Task<Void, Never>?
    /// In-flight Docker Desktop start. Cancelled by the sheet's Cancel /
    /// dismiss — see `cancelDockerStartInFlight()`.
    private var dockerStartTask: Task<Void, Never>?
    private var pasteboard: NSPasteboard { .general }

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
        defer { isRefreshing = false; lastRefresh = Date() }

        // Config
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

        // Discovery — phase 2b.1: prefer one engine round-trip over five
        // sequential local probes; fall back to local on engine-unreachable.
        // The engine-side cache (1s TTL) means concurrent app refreshes share
        // a single set of underlying shell-outs.
        let inputs = await gatherDiscovery()

        // Daemon-state machine: only let probe results override the indicator
        // when we're not in a deliberate UI state (`.starting`, `.startFailed`).
        // Same logic as before — the inputs.dockerDaemonRunning bool just
        // replaces the await DockerProbe.daemonRunning() calls.
        if !dockerSystem.isStarting && !dockerSystem.isStartFailed {
            dockerSystem = inputs.dockerDaemonRunning ? .running : .stopped
        } else if dockerSystem.isStartFailed {
            // Daemon may have come up some other way (user opened Docker
            // Desktop manually) — let that override the stale failure label.
            if inputs.dockerDaemonRunning {
                dockerSystem = .running
            }
        }

        let ports = inputs.ports
        let containers = dockerSystem.isRunning ? inputs.containers : []
        let composeStacks = dockerSystem.isRunning ? inputs.composeStacks : []
        let brew = inputs.brewServices
        let persisted = StatePersistence.load()

        var built: [Service] = []
        var matchedPIDs: Set<Int32> = []
        var matchedManagedPorts: Set<Int> = []

        for spec in config.services {
            switch spec {
            case .project(let f):
                let listening = ports.first(where: { $0.port == f.port })
                let id = "project:\(f.name)"
                let ourSpawn = persisted.spawns.first(where: { $0.serviceID == id })
                let ourSpawnAlive: PersistedSpawn? = ourSpawn.flatMap {
                    ProcessSupervisor.isAlive(pid: $0.pid) ? $0 : nil
                }

                // If we have a live spawn for this service, it's ours regardless
                // of whether lsof has caught up yet (vite takes a few seconds to
                // bind) and regardless of whether the listening PID matches ours
                // (npm spawns vite as a child, so PIDs differ).
                let state: ServiceState
                if let alive = ourSpawnAlive {
                    if let lp = listening {
                        matchedPIDs.insert(lp.pid)
                        matchedManagedPorts.insert(lp.port)
                    }
                    state = .running(pid: alive.pid, since: alive.startedAt)
                } else if let lp = listening {
                    // Something else is on our port.
                    matchedPIDs.insert(lp.pid)
                    matchedManagedPorts.insert(lp.port)
                    if ourSpawn != nil { StatePersistence.remove(serviceID: id) }
                    state = .unmanaged(pid: lp.pid)
                } else {
                    if ourSpawn != nil { StatePersistence.remove(serviceID: id) }
                    state = .stopped
                }

                built.append(Service(
                    spec: spec,
                    state: state,
                    logsPath: Paths.logFile(for: id)
                ))

            case .docker(let f):
                let cname = DockerProbe.inlineContainerName(f.name)
                let container = containers.first(where: { $0.name == cname })
                let listening = ports.first(where: { $0.port == f.port })
                let state: ServiceState
                if let container, container.isRunning {
                    if let lp = listening { matchedPIDs.insert(lp.pid); matchedManagedPorts.insert(lp.port) }
                    state = .running(pid: 0, since: lastRefresh ?? Date())
                } else if let lp = listening {
                    // Something else is on this port.
                    matchedPIDs.insert(lp.pid)
                    matchedManagedPorts.insert(lp.port)
                    state = .unmanaged(pid: lp.pid)
                } else {
                    state = .stopped
                }
                built.append(Service(
                    spec: spec,
                    state: state,
                    logsPath: Paths.logFile(for: "docker:\(f.name)")
                ))

            case .compose(let f):
                // Match by file path, not by name: the compose file may set
                // its own project name via the top-level `name:` directive,
                // which docker uses regardless of what matisa's config calls
                // the service. The file path is the most reliable correlation.
                let stack = composeStacks.first(where: { Self.stackMatches($0, file: f.file) })
                let isRunning = stack.map { $0.status.lowercased().contains("running") } ?? false
                if isRunning {
                    for cp in f.ports {
                        if let lp = ports.first(where: { $0.port == cp.host }) {
                            matchedPIDs.insert(lp.pid); matchedManagedPorts.insert(lp.port)
                        }
                    }
                }
                let state: ServiceState = isRunning
                    ? .running(pid: 0, since: lastRefresh ?? Date())
                    : .stopped
                built.append(Service(
                    spec: spec,
                    state: state,
                    logsPath: Paths.logFile(for: "compose:\(f.name)")
                ))

            case .unmanaged:
                continue
            }
        }

        // Caddy info
        let caddy = brew.first(where: { $0.name == "caddy" })
        self.caddyService = CaddyServiceInfo(
            running: caddy?.isRunning ?? false,
            configFile: config.caddyfile
        )

        self.tunnelConfig = config.tunnel
        self.localNetworkConfig = config.localNetwork

        self.services = built.sorted(by: managedSortKey)

        // After the new states are committed, look at lifecycle transitions
        // to auto-tear-down public tunnels for services that just stopped.
        // Same-network registrations stay up — visitors get a Caddy 502
        // rather than a DNS error, which is more diagnosable.
        for svc in built {
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

        // Unmanaged processes: dev-y listening ports we haven't matched.
        var unmanagedBuilt: [Service] = []
        var seenPIDs: Set<Int32> = []
        var pidsToResolve: [Int32] = []
        var processCommandByPID: [Int32: (command: String, port: Int)] = [:]
        for lp in ports where !matchedPIDs.contains(lp.pid) && !matchedManagedPorts.contains(lp.port) {
            guard UnmanagedHeuristics.looksLikeDevServer(lp) else { continue }
            if lp.pid <= 1 { continue }
            if seenPIDs.contains(lp.pid) { continue }
            seenPIDs.insert(lp.pid)
            pidsToResolve.append(lp.pid)
            processCommandByPID[lp.pid] = (lp.command, lp.port)
        }

        let appNames = await ProcessIntrospect.resolveAppNames(for: pidsToResolve)
        for pid in pidsToResolve {
            guard let info = processCommandByPID[pid] else { continue }
            unmanagedBuilt.append(Service(
                spec: .unmanaged(UnmanagedFields(
                    kind: .process(
                        pid: pid,
                        command: info.command,
                        port: info.port,
                        appName: appNames[pid]
                    )
                )),
                state: .unmanaged(pid: pid),
                logsPath: nil
            ))
        }

        // Unmanaged containers: every container we don't own, running or
        // stopped, so the user can flip them on/off from one place. Use the
        // *actual* docker project name (resolved via file-path match) when
        // available — falls back to the matisa-config name when the stack
        // hasn't been brought up yet (in which case there's no container to
        // claim against this entry anyway).
        let knownComposeNames = Set(config.services.compactMap { spec -> String? in
            guard case .compose(let f) = spec else { return nil }
            if let stack = composeStacks.first(where: { Self.stackMatches($0, file: f.file) }) {
                return stack.name
            }
            return f.name
        })
        for c in containers {
            if c.name.hasPrefix("matisa.") { continue }
            if knownComposeNames.contains(where: {
                c.name.hasPrefix("\($0)-") || c.name.hasPrefix("\($0)_") || c.name == $0
            }) { continue }
            let port = parseFirstHostPort(c.ports)
            let cstate: ServiceState = c.isRunning
                ? .running(pid: 0, since: lastRefresh ?? Date())
                : .stopped
            unmanagedBuilt.append(Service(
                spec: .unmanaged(UnmanagedFields(
                    kind: .container(name: c.name, image: c.image, port: port)
                )),
                state: cstate,
                logsPath: nil
            ))
        }

        self.unmanaged = unmanagedBuilt.sorted { lhs, rhs in
            (lhs.spec.exposedPorts.first?.port ?? 0) < (rhs.spec.exposedPorts.first?.port ?? 0)
        }
    }

    /// Phase 2b.1: gather all discovery probe results in one call. Tries the
    /// engine first; on any transport failure (engine not running, decode
    /// error, etc.) falls back to running the probes locally — the same
    /// async path the app used pre-2b.
    private func gatherDiscovery() async -> DiscoverySnapshot {
        if let snap = try? await EngineClient.shared.call(
            "discovery.snapshot",
            as: DiscoverySnapshot.self
        ) {
            return snap
        }
        // Local fallback. Same sequence as the original refresh() body —
        // the daemon probe gates docker/compose to skip a docker-ps that
        // would just time out when Docker is down.
        let dockerUp = await DockerProbe.daemonRunning()
        let ports = (try? await Lsof.listening()) ?? []
        let containers = dockerUp ? await DockerProbe.listContainers() : []
        let composeStacks = dockerUp ? await DockerProbe.listComposeStacks() : []
        let brew = await BrewServices.list()
        return DiscoverySnapshot(
            ports: ports,
            containers: containers,
            composeStacks: composeStacks,
            brewServices: brew,
            dockerDaemonRunning: dockerUp,
            takenAt: Date()
        )
    }

    /// Parse the first host port from docker's `Ports` string, e.g.
    /// "0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp" → 5432.
    private func parseFirstHostPort(_ raw: String) -> Int? {
        // Look for "<addr>:<port>->" patterns, return the first <port>.
        for chunk in raw.split(separator: ",") {
            let s = chunk.trimmingCharacters(in: .whitespaces)
            guard let arrow = s.range(of: "->") else { continue }
            let left = s[..<arrow.lowerBound]
            guard let colon = left.lastIndex(of: ":") else { continue }
            let portStr = left[left.index(after: colon)...]
            if let p = Int(portStr) { return p }
        }
        return nil
    }

    /// True when `stack`'s `ConfigFiles` list (comma-separated) contains the
    /// given matisa compose-file URL. Path comparison is plain string equality
    /// against the URL's `.path` — symlinked compose files may not match, but
    /// that's not a practical concern in dev setups.
    static func stackMatches(_ stack: DockerComposeStack, file: URL) -> Bool {
        let target = file.path
        return stack.configFiles.split(separator: ",").contains { chunk in
            chunk.trimmingCharacters(in: .whitespaces) == target
        }
    }

    private func managedSortKey(_ a: Service, _ b: Service) -> Bool {
        let order: [ServiceKind: Int] = [.project: 0, .docker: 1, .compose: 2, .unmanaged: 99]
        let ak = order[a.kind] ?? 99
        let bk = order[b.kind] ?? 99
        if ak != bk { return ak < bk }
        return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
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

    /// Toggle the public tunnel for a service. No-op if the service isn't
    /// running or the configured SSH key is missing.
    func togglePublicTunnel(_ service: Service) {
        let status = tunnels.status(for: service.id)
        if status.isActive {
            tunnels.stop(serviceID: service.id)
            return
        }
        guard service.state.isRunning else { return }
        guard TunnelManager.sshKeyExists(tunnelConfig) else {
            // The Share menu disables this case, but guard anyway.
            return
        }
        guard let port = service.spec.exposedPorts.first?.port else { return }
        tunnels.start(
            serviceID: service.id,
            port: port,
            hostHeader: service.spec.primaryURL,
            tunnel: tunnelConfig
        )
    }

    /// Toggle same-network exposure for a service. Adds / removes a
    /// `<name>.matisa.local` mDNS advertisement and a matching Caddyfile block.
    func toggleSameNetwork(_ service: Service) {
        let status = mdns.status(for: service.id)
        if status.isActive {
            mdns.unpublish(serviceID: service.id)
        } else {
            guard mdns.hasLANInterface else { return }
            mdns.advertise(
                serviceID: service.id,
                serviceName: service.name,
                domain: localNetworkConfig.domain
            )
        }
        scheduleCaddyRegen()
    }

    /// Coalesce repeated regen+reload calls — the user toggling both modes for
    /// one service should still result in one Caddy regen+reload, not two.
    private func scheduleCaddyRegen() {
        caddyReloadTask?.cancel()
        caddyReloadTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            await self?.regenerateCaddyfile()
            await self?.reloadCaddy()
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
        // Gate docker/compose actions on daemon availability. If the daemon
        // is down we surface the prompt and bail — the alert flow will retry
        // the action via `confirmDockerStart` once the daemon is up.
        if Self.actionNeedsDocker(action, service: service) {
            if dockerSystem.isStarting { return }
            if !(await DockerProbe.daemonRunning()) {
                dockerSystem = .stopped
                pendingDockerPrompt = PendingDockerPrompt(
                    serviceID: service.id,
                    serviceName: service.name,
                    action: action
                )
                return
            }
            dockerSystem = .running
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

    private func kill(_ service: Service) async {
        switch service.spec {
        case .project:
            if let pid = service.state.pid, pid > 0 {
                let foreign = service.isRunningUnmanaged
                if foreign { ProcessSupervisor.killForeign(pid: pid) }
                else { ProcessSupervisor.forceKill(pid: pid) }
                StatePersistence.remove(serviceID: service.id)
            }
            markState(service.id, .stopped)
        case .docker(let f):
            try? await DockerProbe.inlineKill(name: f.name)
            markState(service.id, .stopped)
        case .compose(let f):
            _ = try? await DockerProbe.composeDown(file: f.file)
            markState(service.id, .stopped)
        case .unmanaged(let f):
            switch f.kind {
            case let .process(pid, _, _, _):
                ProcessSupervisor.killForeign(pid: pid)
            case let .container(name, _, _):
                try? await DockerProbe.unmanagedKill(name: name)
            }
        }
    }

    // MARK: - Build / scripts

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
        tasks.start(
            serviceID: service.id,
            kind: .build,
            name: chosen.name,
            command: chosen.command,
            cwd: service.spec.workingDirectory,
            extraEnv: service.spec.env?.effective(activeContext: activeEnvContext) ?? [:]
        )
    }

    /// Run a named script for a service. No-op if the name isn't configured
    /// or a script is already running for this service.
    func runScript(_ service: Service, named name: String) {
        guard let match = service.spec.scripts.first(where: { $0.name == name }) else { return }
        tasks.start(
            serviceID: service.id,
            kind: .script,
            name: match.name,
            command: match.command,
            cwd: service.spec.workingDirectory,
            extraEnv: service.spec.env?.effective(activeContext: activeEnvContext) ?? [:]
        )
    }

    /// Lifecycle/state-changing actions that go through the docker CLI. Read
    /// actions (URL open, copy, etc.) and project-only kinds skip the gate.
    /// Unmanaged services are split: container actions need docker, process
    /// actions don't.
    private static func actionNeedsDocker(_ action: ServiceAction, service: Service) -> Bool {
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

    /// Quit Docker Desktop. The System panel calls this; doesn't tear down
    /// running services beyond what Docker itself does on quit.
    func performDockerStop() async {
        await DockerProbe.stopDockerDesktop()
        dockerSystem = .stopped
        await refresh()
    }

    /// Launch Docker Desktop and poll until the daemon is reachable. Drives
    /// the System panel start button; doesn't replay any pending action.
    func performDockerStart() async {
        guard !dockerSystem.isStarting else { return }
        dockerSystem = .starting
        let task = Task<Void, Never> { [weak self] in
            await DockerProbe.startDockerDesktop()
            let ready = await DockerProbe.awaitDaemonReady(timeout: 60)
            guard let self else { return }
            // If we were cancelled mid-await, the cancel path has already set
            // `.stopped`; don't stomp on it.
            guard !Task.isCancelled else { return }
            self.dockerSystem = ready ? .running : .startFailed("Docker didn't come up in time")
        }
        dockerStartTask = task
        await task.value
        dockerStartTask = nil
        // Refresh discovery once the attempt has resolved. `.startFailed` is
        // sticky in the probe gate so this won't overwrite the failure label.
        await refresh()
    }

    /// User confirmed the alert: start Docker, then retry the gated action
    /// against the original service. Bails (with a `startFailed` state) if
    /// the daemon never comes up, and silently no-ops if cancelled.
    func confirmDockerStart() async {
        guard let prompt = pendingDockerPrompt else { return }
        pendingDockerPrompt = nil
        dockerSystem = .starting
        let task = Task<Void, Never> { [weak self] in
            await DockerProbe.startDockerDesktop()
            let ready = await DockerProbe.awaitDaemonReady(timeout: 60)
            guard let self else { return }
            guard !Task.isCancelled else { return }
            self.dockerSystem = ready ? .running : .startFailed("Docker didn't come up in time")
        }
        dockerStartTask = task
        await task.value
        dockerStartTask = nil
        // Replay the original action only if the daemon actually came up.
        // If we were cancelled, `dockerSystem` is `.stopped` (set by the
        // cancel path), so this guard skips replay correctly.
        guard case .running = dockerSystem else { return }
        guard let service = self.service(id: prompt.serviceID) else { return }
        await perform(prompt.action, on: service)
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
        dockerStartTask?.cancel()
        dockerStartTask = nil
        pendingDockerPrompt = nil
        dockerSystem = .stopped
        Task.detached { await DockerProbe.stopDockerDesktop() }
    }

    /// Acknowledge a `startFailed` state — clears the indicator so the user
    /// can try again.
    func clearDockerStartFailure() {
        if case .startFailed = dockerSystem {
            dockerSystem = .stopped
        }
    }

    func performCaddy(_ action: CaddyAction) async {
        switch action {
        case .start:    try? await BrewServices.start("caddy")
        case .stop:     try? await BrewServices.stop("caddy")
        case .restart:  try? await BrewServices.restart("caddy")
        case .reload:   await reloadCaddy()
        case .validate: await validateCaddy()
        case .openCaddyfile: openCaddyfile()
        case .revealCaddyfile: revealCaddyfile()
        case .regenerate: await regenerateCaddyfile()
        }
        await refresh()
    }

    // MARK: - Lifecycle

    private func start(_ service: Service) async {
        switch service.spec {
        case .project(let f):
            // Fresh attempt — drop any prior crash-on-launch capture for this
            // service so the UI doesn't keep showing yesterday's failure once
            // the user retries.
            launchFailures.removeValue(forKey: service.id)
            // Fail loudly on path typos rather than letting posix_spawn return
            // ENOENT silently and the UI bounce back to .stopped.
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: f.path.path, isDirectory: &isDir)
            if !exists || !isDir.boolValue {
                let msg = "path not found: \(f.path.path)"
                if let data = "[matisa] \(msg)\n".data(using: .utf8) {
                    let log = Paths.logFile(for: service.id)
                    if !FileManager.default.fileExists(atPath: log.path) {
                        FileManager.default.createFile(atPath: log.path, contents: data)
                    } else if let h = try? FileHandle(forWritingTo: log) {
                        h.seekToEndOfFile(); h.write(data); try? h.close()
                    }
                }
                markState(service.id, .error(msg))
                return
            }
            markState(service.id, .starting)
            do {
                let result = try ProcessSupervisor.spawnDetached(
                    shellCommand: f.command,
                    workingDirectory: f.path,
                    serviceID: service.id,
                    extraEnv: f.env?.effective(activeContext: activeEnvContext) ?? [:]
                )
                let spawnedAt = Date()
                try? await Task.sleep(nanoseconds: 400_000_000)
                StatePersistence.upsert(PersistedSpawn(
                    serviceID: service.id,
                    pid: result.pid,
                    port: f.port,
                    startedAt: spawnedAt,
                    logPath: result.logURL.path
                ))
                markState(service.id, .running(pid: result.pid, since: spawnedAt))
                // Watch for early death — captures the cause when the process
                // crashes in the first ~10s without us noticing. After the
                // window expires the watcher exits silently; later deaths are
                // picked up by the regular refresh loop.
                watchProjectLaunch(
                    serviceID: service.id,
                    pid: result.pid,
                    logURL: result.logURL,
                    startedAt: spawnedAt
                )
            } catch {
                markState(service.id, .error(String(describing: error)))
            }

        case .docker(let f):
            // Fresh attempt — drop stale failure capture.
            launchFailures.removeValue(forKey: service.id)
            markState(service.id, .starting)
            let startedAt = Date()
            do {
                try await DockerProbe.inlineRun(image: f.image, name: f.name, port: f.port)
                markState(service.id, .running(pid: 0, since: startedAt))
            } catch {
                recordDockerFailure(serviceID: service.id, error: error, startedAt: startedAt)
            }

        case .compose(let f):
            launchFailures.removeValue(forKey: service.id)
            markState(service.id, .starting)
            let startedAt = Date()
            do {
                try await DockerProbe.composeUp(file: f.file)
                markState(service.id, .running(pid: 0, since: startedAt))
            } catch {
                recordDockerFailure(serviceID: service.id, error: error, startedAt: startedAt)
            }

        case .unmanaged(let f):
            if case let .container(name, _, _) = f.kind {
                try? await DockerProbe.unmanagedStart(name: name)
            }
        }
    }

    // MARK: - Launch watcher

    /// Polls the spawned project's PID for ~10s after launch. If it dies
    /// inside that window — typical for missing-dep / port-conflict /
    /// command-not-found failures — we read the tail of the log file and
    /// flip the service state to `.error(summary)` so the user sees the
    /// reason instead of the row silently snapping back to stopped.
    /// Detached so the polling sleeps don't run on the main actor.
    private func watchProjectLaunch(
        serviceID: String,
        pid: Int32,
        logURL: URL,
        startedAt: Date
    ) {
        let watchSeconds: TimeInterval = 10
        let pollNS: UInt64 = 200_000_000
        Task.detached { [weak self] in
            let deadline = startedAt.addingTimeInterval(watchSeconds)
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: pollNS)
                if !ProcessSupervisor.isAlive(pid: pid) {
                    let alive = Date().timeIntervalSince(startedAt)
                    let tail = Self.readLogTail(url: logURL, lines: 10)
                    let summary = Self.summarizeFailure(tail: tail, aliveSeconds: alive)
                    let failure = LaunchFailure(
                        failedAt: Date(),
                        aliveSeconds: alive,
                        logTail: tail,
                        summary: summary
                    )
                    await self?.recordLaunchFailure(serviceID: serviceID, failure: failure)
                    return
                }
            }
        }
    }

    /// Mark the service as errored and stash the failure on the store so the
    /// UI can render the tooltip / callout. Called from the detached watcher.
    private func recordLaunchFailure(serviceID: String, failure: LaunchFailure) {
        // Re-resolve the service: by the time we land back on main, the user
        // may have triggered another action — don't overwrite a fresh
        // .starting/.running with a stale failure.
        guard let svc = self.service(id: serviceID) else { return }
        switch svc.state {
        case .running, .stopped, .error:
            launchFailures[serviceID] = failure
            markState(serviceID, .error(failure.summary))
            // The persisted spawn record is no longer accurate (process is
            // dead) — drop it so it doesn't masquerade as live on next refresh.
            StatePersistence.remove(serviceID: serviceID)
        case .starting, .stopping, .unmanaged:
            // User has interacted — leave well alone.
            return
        }
    }

    /// Drop the launch-failure capture for a service — invoked when the user
    /// dismisses the detail-view banner. Doesn't change the service state.
    func clearLaunchFailure(for serviceID: String) {
        launchFailures.removeValue(forKey: serviceID)
    }

    /// Build a `LaunchFailure` from a thrown `ShellError` (or any other
    /// error) and stash it on the store. Used by `start()` for compose and
    /// docker, where the failure mode is a non-zero exit from the docker
    /// CLI itself rather than a process that briefly ran. Sets state to
    /// `.error(summary)` — refresh may overwrite this to `.stopped` shortly,
    /// but the `launchFailures` entry is independent and keeps the red
    /// banner / sidebar pill visible until the user dismisses or retries.
    private func recordDockerFailure(serviceID: String, error: Error, startedAt: Date) {
        let alive = Date().timeIntervalSince(startedAt)
        let (summary, tail): (String, String)
        if let shellError = error as? ShellError {
            switch shellError {
            case let .nonZeroExit(code, stderr):
                tail = stderr
                summary = Self.summarizeStderr(tail, exitCode: code, aliveSeconds: alive)
            case let .timedOut(after):
                tail = ""
                summary = "timed out after \(String(format: "%.0fs", after))"
            case let .spawnFailed(msg):
                tail = ""
                summary = "spawn failed: \(msg)"
            }
        } else {
            tail = ""
            summary = String(describing: error)
        }
        let failure = LaunchFailure(
            failedAt: Date(),
            aliveSeconds: alive,
            logTail: tail,
            summary: summary
        )
        launchFailures[serviceID] = failure
        markState(serviceID, .error(summary))
    }

    /// One-line summary for a non-zero docker CLI exit. Picks the last
    /// non-blank stderr line (where the actual error message lives) and
    /// prepends the alive-time so the user can tell "rejected immediately"
    /// from "tried for a while then gave up".
    nonisolated private static func summarizeStderr(_ stderr: String, exitCode: Int32, aliveSeconds: TimeInterval) -> String {
        let timeStr = String(format: "%.1fs", aliveSeconds)
        let lastLine = stderr
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { !$0.isEmpty })
        if let line = lastLine, !line.isEmpty {
            let maxChars = 100
            let shortened = line.count > maxChars
                ? String(line.prefix(maxChars - 1)) + "…"
                : line
            return "exit \(exitCode) after \(timeStr): \(shortened)"
        }
        return "exit \(exitCode) after \(timeStr) — no output"
    }

    /// Read the last `lines` lines of the service's log file. Returns "" if
    /// the file is missing or unreadable. Mapped read keeps it cheap even
    /// if the file is large.
    nonisolated private static func readLogTail(url: URL, lines: Int) -> String {
        guard let data = try? Data(contentsOf: url, options: .alwaysMapped) else {
            return ""
        }
        guard let s = String(data: data, encoding: .utf8) else { return "" }
        let split = s.split(separator: "\n", omittingEmptySubsequences: false)
        return split.suffix(lines).joined(separator: "\n")
    }

    /// One-line summary for the `.error(...)` state label and tooltip.
    /// Pulls the last non-blank line of the log tail and prepends the
    /// alive-time so users can tell "died on launch" from "ran briefly".
    nonisolated private static func summarizeFailure(tail: String, aliveSeconds: TimeInterval) -> String {
        let lastLine = tail
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { !$0.isEmpty })
        let timeStr = String(format: "%.1fs", aliveSeconds)
        if let line = lastLine, !line.isEmpty {
            let maxChars = 100
            let shortened = line.count > maxChars
                ? String(line.prefix(maxChars - 1)) + "…"
                : line
            return "exited after \(timeStr): \(shortened)"
        }
        return "exited after \(timeStr) — no output"
    }

    private func stop(_ service: Service) async {
        switch service.spec {
        case .project:
            switch service.state {
            case let .running(pid, _):
                markState(service.id, .stopping)
                await ProcessSupervisor.stopWithEscalation(pid: pid)
                StatePersistence.remove(serviceID: service.id)
                markState(service.id, .stopped)
            case let .unmanaged(pid):
                markState(service.id, .stopping)
                await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
                markState(service.id, .stopped)
            default:
                break
            }

        case .docker(let f):
            markState(service.id, .stopping)
            try? await DockerProbe.inlineStop(name: f.name)
            markState(service.id, .stopped)

        case .compose(let f):
            markState(service.id, .stopping)
            try? await DockerProbe.composeDown(file: f.file)
            markState(service.id, .stopped)

        case .unmanaged(let f):
            switch f.kind {
            case let .process(pid, _, _, _):
                await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
            case let .container(name, _, _):
                try? await DockerProbe.unmanagedStop(name: name)
            }
        }
    }

    private func restart(_ service: Service) async {
        switch service.spec {
        case .project:
            await stop(service)
            try? await Task.sleep(nanoseconds: 500_000_000)
            if let updated = self.service(id: service.id) {
                await start(updated)
            }
        case .docker(let f):
            try? await DockerProbe.inlineRestart(name: f.name)
        case .compose(let f):
            try? await DockerProbe.composeRestart(file: f.file)
        case .unmanaged:
            break
        }
    }

    /// Take over a managed service that's currently running unmanaged.
    /// Stop the rogue PID, then spawn under our supervisor.
    private func takeOver(_ service: Service) async {
        guard case let .unmanaged(pid) = service.state else { return }
        guard case .project = service.spec else {
            // For docker/compose, the "running unmanaged" case means something
            // else is on the port; we can't take that over, only stop it.
            await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
            return
        }
        markState(service.id, .stopping)
        await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
        try? await Task.sleep(nanoseconds: 400_000_000)
        await start(service)
    }

    private func pull(_ service: Service) async {
        switch service.spec {
        case .docker(let f):
            try? await DockerProbe.inlinePull(image: f.image)
        case .compose(let f):
            try? await DockerProbe.composePull(file: f.file)
        default:
            break
        }
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
        guard let path = caddyService.configFile else { return }
        guard let caddyBin = Shell.which("caddy") else { return }
        _ = try? await Shell.run(
            executable: caddyBin,
            arguments: ["validate", "--config", path.path, "--adapter", "caddyfile"]
        )
    }

    private func reloadCaddy() async {
        try? await BrewServices.restart("caddy")
    }

    private func regenerateCaddyfile() async {
        guard let config = configLoader.lastConfig else { return }
        _ = try? CaddyfileGenerator.write(
            config,
            services: services,
            exposures: activeExposuresByServiceID
        )
    }

    // MARK: - Helpers

    private func markState(_ id: String, _ state: ServiceState) {
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

struct CaddyServiceInfo: Hashable, Sendable {
    let running: Bool
    let configFile: URL?
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
