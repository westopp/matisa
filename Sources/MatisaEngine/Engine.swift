import Foundation
import MatisaCore

/// Top-level engine. Owns the socket server and the method dispatcher.
/// Method registration happens once at init time; the dispatcher is read-only
/// after that, so worker threads can read it without synchronization.
final class Engine {

    static let version = "0.3.0-phase2b"

    private let socketPath: String
    private let dispatcher = MethodDispatcher()
    private let server: UnixSocketServer
    private let configService = ConfigService()
    private let discoveryService = DiscoveryService()
    private let servicesService: ServicesService
    private let lifecycleService: LifecycleService
    private let startedAt = Date()

    init() {
        self.socketPath = Engine.resolveSocketPath()
        let servicesService = ServicesService(
            configService: configService,
            discoveryService: discoveryService
        )
        self.servicesService = servicesService
        // Closure-based lookup keeps LifecycleService decoupled from
        // ConfigService — tests can inject a stub without round-tripping
        // through bun. `lookup` reuses the merged snapshot so the engine
        // sees the same view that drives `services.snapshot`.
        self.lifecycleService = LifecycleService(
            lookupService: { id in try servicesService.lookup(serviceID: id) },
            spawnStore: servicesService.spawnStoreRef
        )

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
