import Foundation
import MatisaCore

/// Top-level engine. Owns the socket server and the method dispatcher.
/// Method registration happens once at init time; the dispatcher is read-only
/// after that, so worker threads can read it without synchronization.
final class Engine {

    static let version = "0.4.0-phase2c"

    private let socketPath: String
    private let dispatcher = MethodDispatcher()
    private let server: UnixSocketServer
    private let configService = ConfigService()
    private let discoveryService = DiscoveryService()
    private let servicesService: ServicesService
    private let lifecycleService: LifecycleService
    private let dockerDaemonService = DockerDaemonService()
    private let caddyService: CaddyService
    private let taskService = TaskService()
    private let tunnelService: TunnelService
    private let mdnsService: MDNSService
    private let startedAt = Date()

    init() {
        self.socketPath = Engine.resolveSocketPath()
        // Construct the persisted-spawn store once and inject the same
        // instance into both services. Snapshot reads and lifecycle writes
        // share a single queue inside the store; the alternative
        // (default-constructing inside each service) would silently produce
        // two instances racing the same file.
        let spawnStore = PersistedSpawnStore()
        let servicesService = ServicesService(
            configService: configService,
            discoveryService: discoveryService,
            spawnStore: spawnStore
        )
        self.servicesService = servicesService
        // Closure-based lookup keeps LifecycleService decoupled from
        // ConfigService — tests can inject a stub without round-tripping
        // through bun. `lookup` reuses the merged snapshot so the engine
        // sees the same view that drives `services.snapshot`.
        self.lifecycleService = LifecycleService(
            lookupService: { id in try servicesService.lookup(serviceID: id) },
            spawnStore: spawnStore
        )
        self.caddyService = CaddyService(
            configService: configService,
            servicesService: servicesService,
            discoveryService: discoveryService
        )
        // Phase 2e.1: tunnels. Closure-injected lookups keep TunnelService
        // free of a hard dependency on ConfigService / ServicesService —
        // tests can stand it up without bun. The post-snapshot hook is
        // setter-injected (rather than ctor-passed) to avoid a circular
        // init dep: TunnelService captures a closure that calls back into
        // ServicesService.lookup, so ServicesService can't hold the
        // TunnelService at construction time.
        let configService = self.configService
        self.tunnelService = TunnelService(
            lookupService: { id in try servicesService.lookup(serviceID: id) },
            loadTunnelConfig: {
                let bytes = try configService.get()
                do {
                    let raw = try JSONDecoder().decode(RawConfig.self, from: bytes)
                    let app = try AppConfig.from(raw)
                    return app.tunnel
                } catch {
                    throw RPCError.internalError("config decode failed: \(error)")
                }
            }
        )
        let tunnelService = self.tunnelService
        servicesService.postSnapshotHook = { managed in
            tunnelService.reconcileAfterSnapshot(managed)
        }

        // Phase 2e.2: same-network (mDNS). Constructed after CaddyService so
        // `onStateChanged` can capture it weakly — every toggle / refresh /
        // markActive transition fires the debounced regen+reload that's been
        // dormant since Phase 2d. Unlike TunnelService there's no
        // post-snapshot teardown hook: same-network registrations stay up
        // even after the backing service stops (visitors get a Caddy 502
        // rather than a DNS error, which is more diagnosable).
        let caddyService = self.caddyService
        self.mdnsService = MDNSService(
            lookupService: { id in try servicesService.lookup(serviceID: id) },
            loadLocalNetworkConfig: {
                let bytes = try configService.get()
                do {
                    let raw = try JSONDecoder().decode(RawConfig.self, from: bytes)
                    let app = try AppConfig.from(raw)
                    return app.localNetwork
                } catch {
                    throw RPCError.internalError("config decode failed: \(error)")
                }
            },
            onStateChanged: { [weak caddyService] in
                caddyService?.scheduleRegenAndReload()
            }
        )

        // Now that both exposure services exist, wire CaddyService's
        // exposures source. Captures both services weakly so the closure
        // doesn't extend their lifetime past Engine's. The filter mirrors
        // the app's `activeExposuresByServiceID` — only services with at
        // least one active leg show up in the Caddyfile.
        let mdnsService = self.mdnsService
        caddyService.loadExposures = { [weak tunnelService, weak mdnsService] in
            let tunnels = tunnelService?.list() ?? [:]
            let mdns = mdnsService?.list() ?? [:]
            var out: [String: ServiceExposure] = [:]
            let ids = Set(tunnels.keys).union(mdns.keys)
            for id in ids {
                out[id] = ServiceExposure(
                    publicTunnel: tunnels[id] ?? .idle,
                    sameNetwork: mdns[id] ?? .idle
                )
            }
            return out.filter { $0.value.hasAnyActive }
        }

        // Capture dispatcher locally so the closure doesn't need self.
        // The accept callback runs synchronously on a growing dispatch worker
        // queue; the connection loop's blocking read(2) belongs there, not on
        // the cooperative pool. ConnectionHandler bridges to async around
        // each handler call internally.
        let dispatcher = self.dispatcher
        self.server = UnixSocketServer(path: socketPath) { fd in
            ConnectionHandler(fd: fd, dispatcher: dispatcher).run()
        }

        registerMethods()
    }

    func start() throws {
        try server.start()
        FileHandle.standardError.write(Data("matisa-engine: listening on \(socketPath)\n".utf8))
        // Best-effort eager load so the first client request lands on a warm
        // cache. Errors are stored on the service and surface via config.status.
        configService.preload()
    }

    func stop() {
        server.stop()
    }

    // MARK: - Methods

    /// Method-naming convention: dotted namespaces, lowercase.
    /// Examples that already exist or are planned:
    ///   engine.status, engine.shutdown
    ///   config.status, config.get
    ///   services.list, services.start, services.stop, services.logs.tail
    ///   docker.daemon.status, docker.daemon.start
    ///   env.contexts.list, env.contexts.set
    /// Keep this consistent — once clients code to a name it's a breaking change.
    private func registerMethods() {
        // engine.status — phase 0. No params.
        dispatcher.register("engine.status") { [self] () -> EngineStatus in
            EngineStatus(
                status: "ok",
                version: Engine.version,
                uptimeSeconds: Int(Date().timeIntervalSince(startedAt))
            )
        }

        // config.status — phase 2a. Cheap diagnostic; never re-runs bun.
        dispatcher.register("config.status") { [configService] () -> ConfigService.Status in
            configService.status()
        }

        // config.get — phase 2a. Returns the raw bun eval JSON verbatim.
        // The shape matches what the app's existing `RawConfig` decoder
        // expects, so the app can decode the response with no translation.
        dispatcher.registerRaw("config.get") { [configService] in
            try configService.get()
        }

        // services.snapshot — phase 2b.2. The merged service list: config
        // services with their current ServiceState, plus synthesised
        // unmanaged entries for foreign dev processes and containers. One
        // round-trip replaces the app's previous config + discovery + merge
        // loop. App's ServiceStore consumes this directly; falls back to
        // running the same merge locally when the engine is unreachable.
        dispatcher.register("services.snapshot") { [servicesService] () -> ServicesSnapshot in
            try servicesService.snapshot()
        }

        // discovery.snapshot — phase 2b.1. Raw probe results. The app's
        // local-fallback path still uses this when services.snapshot fails,
        // so the merge can run against engine-cached discovery even if the
        // engine's services.snapshot itself failed (e.g. config error).
        dispatcher.register("discovery.snapshot") { [discoveryService] () -> DiscoverySnapshot in
            discoveryService.snapshot()
        }

        // Lifecycle — phase 2c.2. Each method returns `{}` on success;
        // clients drive their UI off `services.snapshot` (poll loop). All
        // gated docker/compose paths throw `dockerDaemonRequired` (-32001)
        // if the daemon isn't reachable. Method names are snake_case for
        // multi-word — `services.take_over` not `services.takeOver`.
        dispatcher.register("services.start") { [lifecycleService] (p: ServiceIDParams) -> EmptyResponse in
            try await lifecycleService.start(serviceID: p.id)
            return EmptyResponse()
        }
        dispatcher.register("services.stop") { [lifecycleService] (p: ServiceIDParams) -> EmptyResponse in
            try await lifecycleService.stop(serviceID: p.id)
            return EmptyResponse()
        }
        dispatcher.register("services.kill") { [lifecycleService] (p: ServiceIDParams) -> EmptyResponse in
            try await lifecycleService.kill(serviceID: p.id)
            return EmptyResponse()
        }
        dispatcher.register("services.restart") { [lifecycleService] (p: ServiceIDParams) -> EmptyResponse in
            try await lifecycleService.restart(serviceID: p.id)
            return EmptyResponse()
        }
        dispatcher.register("services.take_over") { [lifecycleService] (p: ServiceIDParams) -> EmptyResponse in
            try await lifecycleService.takeOver(serviceID: p.id)
            return EmptyResponse()
        }
        dispatcher.register("services.pull") { [lifecycleService] (p: ServiceIDParams) -> EmptyResponse in
            try await lifecycleService.pull(serviceID: p.id)
            return EmptyResponse()
        }

        // Launch-failure tracker — captured by the project launch-watcher
        // (10s window) and the docker-CLI failure paths. Clients fetch the
        // map to render error banners; clearing is a user-driven dismiss.
        dispatcher.register("launch_failures.list") { [lifecycleService] () -> LaunchFailuresList in
            LaunchFailuresList(failures: lifecycleService.listLaunchFailures())
        }
        dispatcher.register("launch_failures.clear") { [lifecycleService] (p: ServiceIDParams) -> EmptyResponse in
            lifecycleService.clearLaunchFailure(serviceID: p.id)
            return EmptyResponse()
        }

        // Docker daemon control — phase 2f. The engine owns the
        // DockerSystemState machine; the app's ServiceStore mirrors the
        // state during refresh and keeps the UI affordances (the
        // "Starting Docker Desktop…" sheet, pendingDockerPrompt). `start`
        // and `stop` kick off the work and return; clients poll
        // `docker.daemon.status` for the result, same shape as
        // `services.start`.
        dispatcher.register("docker.daemon.status") { [dockerDaemonService] () -> DockerSystemState in
            dockerDaemonService.status()
        }
        dispatcher.register("docker.daemon.start") { [dockerDaemonService] () -> EmptyResponse in
            await dockerDaemonService.start()
            return EmptyResponse()
        }
        dispatcher.register("docker.daemon.stop") { [dockerDaemonService] () -> EmptyResponse in
            await dockerDaemonService.stop()
            return EmptyResponse()
        }
        dispatcher.register("docker.daemon.cancel_start") { [dockerDaemonService] () -> EmptyResponse in
            dockerDaemonService.cancelStart()
            return EmptyResponse()
        }
        dispatcher.register("docker.daemon.clear_failure") { [dockerDaemonService] () -> EmptyResponse in
            dockerDaemonService.clearFailure()
            return EmptyResponse()
        }

        // Caddy lifecycle + Caddyfile generation — phase 2d. The engine owns
        // the brew-managed lifecycle, the rendered Caddyfile on disk, and the
        // regen+reload debounce. The app mirrors `caddy.status` into
        // `ServiceStore.caddyService` on refresh and routes user-facing
        // actions through these methods with `*Local` fallbacks. `regenerate`
        // writes the file only; the regen+reload combo lives on the engine
        // as `scheduleRegenAndReload` and is reserved for the in-engine mDNS
        // toggle flow landing in 2e.2.
        dispatcher.register("caddy.status") { [caddyService] () -> CaddyServiceInfo in
            caddyService.status()
        }
        dispatcher.register("caddy.start") { [caddyService] () -> EmptyResponse in
            try await caddyService.start()
            return EmptyResponse()
        }
        dispatcher.register("caddy.stop") { [caddyService] () -> EmptyResponse in
            try await caddyService.stop()
            return EmptyResponse()
        }
        dispatcher.register("caddy.restart") { [caddyService] () -> EmptyResponse in
            try await caddyService.restart()
            return EmptyResponse()
        }
        dispatcher.register("caddy.reload") { [caddyService] () -> EmptyResponse in
            try await caddyService.reload()
            return EmptyResponse()
        }
        dispatcher.register("caddy.validate") { [caddyService] () -> CaddyValidationResult in
            try await caddyService.validate()
        }
        dispatcher.register("caddy.regenerate") { [caddyService] () -> EmptyResponse in
            _ = try await caddyService.regenerate()
            return EmptyResponse()
        }

        // Ad-hoc tasks (build / script invocations) — phase 2e.3. Engine owns
        // the per-(serviceID, kind) slot map and the underlying Process
        // lifecycle. App polls `tasks.list(id)` for services with a visible
        // pane and mirrors the result into its local TaskRunner so the
        // existing SwiftUI bindings keep working. Method names are snake_case
        // for multi-word — `tasks.close_pane` not `tasks.closePane`.
        dispatcher.register("tasks.start") { [taskService] (p: TaskStartParams) -> EmptyResponse in
            taskService.start(
                serviceID: p.id,
                kind: p.kind,
                name: p.name,
                command: p.command,
                cwd: p.cwd,
                extraEnv: p.extraEnv
            )
            return EmptyResponse()
        }
        dispatcher.register("tasks.cancel") { [taskService] (p: TaskCancelParams) -> EmptyResponse in
            taskService.cancel(serviceID: p.id, kind: p.kind)
            return EmptyResponse()
        }
        dispatcher.register("tasks.clear") { [taskService] (p: TaskCancelParams) -> EmptyResponse in
            taskService.clear(serviceID: p.id, kind: p.kind)
            return EmptyResponse()
        }
        dispatcher.register("tasks.close_pane") { [taskService] (p: TaskCancelParams) -> EmptyResponse in
            taskService.closePane(serviceID: p.id, kind: p.kind)
            return EmptyResponse()
        }
        dispatcher.register("tasks.list") { [taskService] (p: ServiceIDParams) -> TaskList in
            TaskList(slots: taskService.list(serviceID: p.id))
        }

        // Public tunnels (sish) — phase 2e.1. Engine spawns the SSH child,
        // parses sish's banner for the assigned hostname, and tears the
        // tunnel down automatically when the underlying service stops (via
        // ServicesService.postSnapshotHook → TunnelService.reconcileAfterSnapshot).
        // All gating (service running, ssh key present, port available)
        // happens engine-side; the toggle RPC is a single fire-and-forget.
        dispatcher.register("exposure.public_tunnel.toggle") { [tunnelService] (p: ServiceIDParams) -> EmptyResponse in
            tunnelService.toggle(serviceID: p.id)
            return EmptyResponse()
        }
        dispatcher.register("exposure.public_tunnel.status") { [tunnelService] (p: ServiceIDParams) -> PublicTunnelStatus in
            tunnelService.status(serviceID: p.id)
        }
        dispatcher.register("exposure.public_tunnel.list") { [tunnelService] () -> PublicTunnelStatusList in
            PublicTunnelStatusList(statuses: tunnelService.list())
        }

        // Same-network (mDNS) — phase 2e.2. Engine spawns one `dns-sd -P`
        // child per active hostname, watches for Wi-Fi switches / sleep-wake
        // via NWPathMonitor, and fires CaddyService.scheduleRegenAndReload
        // after every state mutation so the rendered Caddyfile picks up
        // `<service>.matisa.local` blocks within the 150ms debounce window.
        // Unlike public tunnels there's no auto-teardown when the backing
        // service stops — same-network registrations stay up by design.
        dispatcher.register("exposure.same_network.toggle") { [mdnsService] (p: ServiceIDParams) -> EmptyResponse in
            mdnsService.toggle(serviceID: p.id)
            return EmptyResponse()
        }
        dispatcher.register("exposure.same_network.status") { [mdnsService] (p: ServiceIDParams) -> SameNetworkStatus in
            mdnsService.status(serviceID: p.id)
        }
        dispatcher.register("exposure.same_network.list") { [mdnsService] () -> SameNetworkStatusList in
            SameNetworkStatusList(statuses: mdnsService.list())
        }
    }

    // MARK: - Socket path

    /// Resolution order:
    ///   1. $MATISA_SOCKET (escape hatch for tests / non-default installs)
    ///   2. ~/Library/Application Support/Matisa/matisa.sock
    private static func resolveSocketPath() -> String {
        if let override = ProcessInfo.processInfo.environment["MATISA_SOCKET"], !override.isEmpty {
            return override
        }
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first!
        return appSupport
            .appendingPathComponent("Matisa", isDirectory: true)
            .appendingPathComponent("matisa.sock")
            .path
    }
}
