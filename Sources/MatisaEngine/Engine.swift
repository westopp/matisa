import Foundation

/// Top-level engine. Owns the socket server and the method dispatcher.
/// Method registration happens once at init time; the dispatcher is read-only
/// after that, so worker threads can read it without synchronization.
final class Engine {

    static let version = "0.1.0-phase1"

    private let socketPath: String
    private let dispatcher = MethodDispatcher()
    private let server: UnixSocketServer
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
    }

    func stop() {
        server.stop()
    }

    // MARK: - Methods

    /// Method-naming convention: dotted namespaces, lowercase.
    /// Examples that already exist or are planned:
    ///   engine.status, engine.shutdown
    ///   projects.list, projects.start, projects.stop, projects.logs.tail
    ///   docker.daemon.status, docker.daemon.start
    ///   env.context.list, env.context.set
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

        // projects.list — phase 1. No params. Stub data; phase 2 will wire this
        // to the real project state migrated out of the app.
        dispatcher.register("projects.list") { () -> ProjectList in
            ProjectList(projects: [
                .init(id: "web",    name: "Web",    group: "frontend", status: "stopped"),
                .init(id: "api",    name: "API",    group: "backend",  status: "running"),
                .init(id: "worker", name: "Worker", group: "backend",  status: "stopped"),
            ])
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
