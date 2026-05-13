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
    private let startedAt = Date()

    init() {
        self.socketPath = Engine.resolveSocketPath()

        // Capture dispatcher locally so the closure doesn't need self.
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

        // projects.list / services.list — placeholder. Phase 2b.2 will replace
        // this with the real merged spec+state list once the merge logic
        // moves out of the app's ServiceStore and into the engine. Returning
        // empty for now so clients don't see stub data.
        dispatcher.register("services.list") { () -> ServiceList in
            ServiceList(services: [])
        }

        // discovery.snapshot — phase 2b.1. Single-call merge of all four
        // probes (lsof, docker ps, docker compose ls, brew services list)
        // plus the docker daemon-running flag. Server-side TTL cache means
        // multiple clients during the same refresh tick share one round of
        // shell-outs. App's ServiceStore.refresh() reads this and runs its
        // existing merge logic against the result.
        dispatcher.register("discovery.snapshot") { [discoveryService] () -> DiscoverySnapshot in
            discoveryService.snapshot()
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
