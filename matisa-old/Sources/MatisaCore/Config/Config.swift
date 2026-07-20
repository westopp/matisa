import Foundation

/// In-memory representation of `~/.config/matisa/services.ts` after
/// evaluation. All paths have been expanded (no `~`) and resolved to URLs.
public struct AppConfig: Sendable {
    public let caddyfile: URL?
    public let services: [ServiceSpec]
    public let tunnel: TunnelConfig
    public let localNetwork: LocalNetworkConfig

    public init(
        caddyfile: URL?,
        services: [ServiceSpec],
        tunnel: TunnelConfig,
        localNetwork: LocalNetworkConfig
    ) {
        self.caddyfile = caddyfile
        self.services = services
        self.tunnel = tunnel
        self.localNetwork = localNetwork
    }
}

/// Public-tunnel (sish) settings. Defaults are baked in so users don't have
/// to declare anything to use the feature.
public struct TunnelConfig: Hashable, Sendable {
    public let sshKeyPath: URL
    public let server: String
    public let port: Int
    public let user: String

    public init(sshKeyPath: URL, server: String, port: Int, user: String) {
        self.sshKeyPath = sshKeyPath
        self.server = server
        self.port = port
        self.user = user
    }

    public static let defaults = TunnelConfig(
        sshKeyPath: URL(fileURLWithPath: NSString(string: "~/.ssh/sish_tunnel").expandingTildeInPath),
        server: "tunnel.westopp.com",
        port: 2222,
        user: "matisa"
    )
}

/// Same-network advertisement settings. Services are exposed as
/// `<service>.<domain>` over mDNS.
public struct LocalNetworkConfig: Hashable, Sendable {
    public let domain: String

    public init(domain: String) { self.domain = domain }

    public static let defaults = LocalNetworkConfig(domain: "matisa.local")
}

/// Raw schema as decoded from the bun-evaluated JSON. Path strings are still
/// `~`-prefixed at this stage; `AppConfig.from(_:)` expands them.
public struct RawConfig: Decodable {
    public var caddyfile: String?
    public var services: [RawService] = []
    public var tunnel: RawTunnel?
    public var localNetwork: RawLocalNetwork?

    public init() {}
}

public struct RawTunnel: Decodable {
    public let sshKeyPath: String?
    public let server: String?
    public let port: Int?
    public let user: String?
}

public struct RawLocalNetwork: Decodable {
    public let domain: String?
}

public struct RawService: Decodable {
    public let type: String
    // project
    public let name: String?
    public let path: String?
    public let port: Int?
    public let url: String?
    public let command: String?
    // docker
    public let image: String?
    // compose
    public let file: String?
    public let ports: [RawComposePort]?
    // common
    public let commands: [RawNamedCommand]?
    public let group: String?
    public let env: RawEnv?
}

public struct RawEnvVar: Decodable, Hashable {
    public let name: String
    public let value: String
}

public struct RawEnvContext: Decodable, Hashable {
    public let name: String
    public let vars: [RawEnvVar]
}

/// `env` is normalised by the bun eval into ordered arrays before reaching
/// Swift, since JSONSerialization on Apple platforms doesn't preserve
/// object key order. Same trick we use for `scripts`.
public struct RawEnv: Decodable, Hashable {
    public let vars: [RawEnvVar]
    public let contexts: [RawEnvContext]
}

public struct RawComposePort: Decodable {
    public let host: Int
    public let url: String?
}

public struct RawNamedCommand: Decodable, Hashable {
    public let name: String
    public let command: String
    public let env: RawEnv?
}

public enum ConfigError: Error, CustomStringConvertible {
    case bunMissing
    case configMissing(URL)
    case evalFailed(stderr: String)
    case parseFailed(String)
    case invalidEntry(String)

    public var description: String {
        switch self {
        case .bunMissing:
            "bun is not installed or not in PATH"
        case .configMissing(let url):
            "config file not found at \(url.path)"
        case .evalFailed(let stderr):
            "config evaluation failed:\n\(stderr)"
        case .parseFailed(let msg):
            "config parse failed: \(msg)"
        case .invalidEntry(let msg):
            "invalid service entry: \(msg)"
        }
    }
}

public extension AppConfig {
    static func from(_ raw: RawConfig) throws -> AppConfig {
        let caddyfile = raw.caddyfile.map { Self.expand($0) }

        let specs: [ServiceSpec] = try raw.services.map { rs in
            switch rs.type {
            case "project":
                guard let name = rs.name, !name.isEmpty else {
                    throw ConfigError.invalidEntry("project entry missing 'name'")
                }
                guard let pathStr = rs.path else {
                    throw ConfigError.invalidEntry("project '\(name)' missing 'path'")
                }
                guard let port = rs.port else {
                    throw ConfigError.invalidEntry("project '\(name)' missing 'port'")
                }
                guard let cmd = rs.command, !cmd.isEmpty else {
                    throw ConfigError.invalidEntry("project '\(name)' missing 'command'")
                }
                return .project(ProjectFields(
                    name: name,
                    path: Self.expand(pathStr),
                    port: port,
                    url: rs.url,
                    command: cmd,
                    commands: Self.commandsFromRaw(rs.commands),
                    group: Self.normaliseGroup(rs.group),
                    env: Self.envFromRaw(rs.env)
                ))

            case "docker":
                guard let name = rs.name, !name.isEmpty else {
                    throw ConfigError.invalidEntry("docker entry missing 'name'")
                }
                guard let image = rs.image else {
                    throw ConfigError.invalidEntry("docker '\(name)' missing 'image'")
                }
                guard let port = rs.port else {
                    throw ConfigError.invalidEntry("docker '\(name)' missing 'port'")
                }
                return .docker(DockerFields(
                    name: name,
                    image: image,
                    port: port,
                    url: rs.url,
                    commands: Self.commandsFromRaw(rs.commands),
                    group: Self.normaliseGroup(rs.group)
                ))

            case "compose":
                guard let name = rs.name, !name.isEmpty else {
                    throw ConfigError.invalidEntry("compose entry missing 'name'")
                }
                guard let fileStr = rs.file else {
                    throw ConfigError.invalidEntry("compose '\(name)' missing 'file'")
                }
                let composePorts = (rs.ports ?? []).map { ComposePort(host: $0.host, url: $0.url) }
                return .compose(ComposeFields(
                    name: name,
                    file: Self.expand(fileStr),
                    ports: composePorts,
                    commands: Self.commandsFromRaw(rs.commands),
                    group: Self.normaliseGroup(rs.group)
                ))

            default:
                throw ConfigError.invalidEntry("unknown service type '\(rs.type)'")
            }
        }

        let tunnel = Self.tunnelFromRaw(raw.tunnel)
        let localNetwork = Self.localNetworkFromRaw(raw.localNetwork)

        return AppConfig(
            caddyfile: caddyfile,
            services: specs,
            tunnel: tunnel,
            localNetwork: localNetwork
        )
    }

    static func tunnelFromRaw(_ raw: RawTunnel?) -> TunnelConfig {
        let d = TunnelConfig.defaults
        guard let raw else { return d }
        let key = raw.sshKeyPath.map(Self.expand) ?? d.sshKeyPath
        let server = raw.server?.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = raw.user?.trimmingCharacters(in: .whitespacesAndNewlines)
        return TunnelConfig(
            sshKeyPath: key,
            server: (server?.isEmpty == false ? server! : d.server),
            port: raw.port ?? d.port,
            user: (user?.isEmpty == false ? user! : d.user)
        )
    }

    static func localNetworkFromRaw(_ raw: RawLocalNetwork?) -> LocalNetworkConfig {
        let d = LocalNetworkConfig.defaults
        guard let raw else { return d }
        let domain = raw.domain?.trimmingCharacters(in: .whitespacesAndNewlines)
        return LocalNetworkConfig(
            domain: (domain?.isEmpty == false ? domain! : d.domain)
        )
    }

    static func normaliseGroup(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func commandsFromRaw(_ raw: [RawNamedCommand]?) -> [NamedCommand] {
        (raw ?? [])
            .filter { !$0.name.isEmpty && !$0.command.isEmpty }
            .map { NamedCommand(name: $0.name, command: $0.command, env: Self.envFromRaw($0.env)) }
    }

    static func envFromRaw(_ raw: RawEnv?) -> EnvSpec? {
        guard let raw else { return nil }
        let base = raw.vars
            .filter { !$0.name.isEmpty }
            .map { EnvVar(name: $0.name, value: $0.value) }
        let contexts = raw.contexts
            .filter { !$0.name.isEmpty }
            .map { c in
                EnvContext(
                    name: c.name,
                    vars: c.vars
                        .filter { !$0.name.isEmpty }
                        .map { EnvVar(name: $0.name, value: $0.value) }
                )
            }
        if base.isEmpty && contexts.isEmpty { return nil }
        return EnvSpec(base: base, contexts: contexts)
    }

    static func expand(_ path: String) -> URL {
        var s = path
        if s.hasPrefix("~/") {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            s = home + String(s.dropFirst(1))
        } else if s == "~" {
            s = FileManager.default.homeDirectoryForCurrentUser.path
        }
        return URL(fileURLWithPath: s)
    }
}
