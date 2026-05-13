import Foundation

/// One listening socket discovered by `lsof`.
public struct ListeningPort: Hashable, Sendable, Codable {
    public let pid: Int32
    public let command: String      // process name as lsof reports it
    public let address: String      // raw address string e.g. "*:5478", "127.0.0.1:5478", "[::1]:5478"
    public let port: Int

    public init(pid: Int32, command: String, address: String, port: Int) {
        self.pid = pid
        self.command = command
        self.address = address
        self.port = port
    }

    public var isLocalhost: Bool {
        address.hasPrefix("127.") || address.hasPrefix("[::1]") || address.hasPrefix("*")
    }
}

/// One container as seen by `docker ps -a`.
public struct DockerContainer: Hashable, Sendable, Codable {
    public let id: String
    public let name: String
    public let image: String
    public let state: String
    public let status: String
    public let ports: String

    public init(id: String, name: String, image: String, state: String, status: String, ports: String) {
        self.id = id
        self.name = name
        self.image = image
        self.state = state
        self.status = status
        self.ports = ports
    }

    public var isRunning: Bool { state == "running" }
}

/// One compose stack as seen by `docker compose ls`.
public struct DockerComposeStack: Hashable, Sendable, Codable {
    public let name: String
    public let status: String
    public let configFiles: String

    public init(name: String, status: String, configFiles: String) {
        self.name = name
        self.status = status
        self.configFiles = configFiles
    }
}

/// One brew-services entry.
public struct BrewService: Hashable, Sendable, Codable {
    public let name: String
    public let status: String  // "started", "stopped", "error"
    public let user: String
    public let plist: String

    public init(name: String, status: String, user: String, plist: String) {
        self.name = name
        self.status = status
        self.user = user
        self.plist = plist
    }

    public var isRunning: Bool { status.lowercased() == "started" }
}

/// One snapshot of all discovery probes — the engine produces this in
/// `discovery.snapshot`. Single round-trip avoids five sequential RPCs per
/// app refresh tick. Cached briefly server-side so concurrent callers share
/// a single set of underlying shell-outs.
public struct DiscoverySnapshot: Hashable, Sendable, Codable {
    public let ports: [ListeningPort]
    public let containers: [DockerContainer]
    public let composeStacks: [DockerComposeStack]
    public let brewServices: [BrewService]
    public let dockerDaemonRunning: Bool
    public let takenAt: Date

    public init(
        ports: [ListeningPort],
        containers: [DockerContainer],
        composeStacks: [DockerComposeStack],
        brewServices: [BrewService],
        dockerDaemonRunning: Bool,
        takenAt: Date
    ) {
        self.ports = ports
        self.containers = containers
        self.composeStacks = composeStacks
        self.brewServices = brewServices
        self.dockerDaemonRunning = dockerDaemonRunning
        self.takenAt = takenAt
    }
}
