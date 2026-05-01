import Foundation

/// In-memory representation of `~/.config/matisa/services.ts` after
/// evaluation. All paths have been expanded (no `~`) and resolved to URLs.
struct AppConfig: Sendable {
    let caddyfile: URL?
    let services: [ServiceSpec]
}

/// Raw schema as decoded from the bun-evaluated JSON. Path strings are still
/// `~`-prefixed at this stage; `AppConfig.from(_:)` expands them.
struct RawConfig: Decodable {
    var caddyfile: String?
    var services: [RawService] = []
}

struct RawService: Decodable {
    let type: String
    // project
    let name: String?
    let path: String?
    let port: Int?
    let url: String?
    let command: String?
    // docker
    let image: String?
    // compose
    let file: String?
    let ports: [RawComposePort]?
    // common
    let build: RawBuild?
    let scripts: [RawNamedCommand]?
}

struct RawComposePort: Decodable {
    let host: Int
    let url: String?
}

struct RawNamedCommand: Decodable, Hashable {
    let name: String
    let command: String
}

/// `build:` accepts either a string (single direct-run command) or an array
/// of `{ name, command }` objects (the bun eval normalises `Record<string, string>`
/// to that shape, preserving JS object key order).
enum RawBuild: Decodable {
    case single(String)
    case multi([RawNamedCommand])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) {
            self = .single(s)
            return
        }
        if let arr = try? c.decode([RawNamedCommand].self) {
            self = .multi(arr)
            return
        }
        throw ConfigError.parseFailed("'build' must be a string or a Record<string, string>")
    }
}

enum ConfigError: Error, CustomStringConvertible {
    case bunMissing
    case configMissing(URL)
    case evalFailed(stderr: String)
    case parseFailed(String)
    case invalidEntry(String)

    var description: String {
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

extension AppConfig {
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
                    build: Self.buildFromRaw(rs.build, owner: "project '\(name)'"),
                    scripts: Self.scriptsFromRaw(rs.scripts)
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
                if rs.build != nil {
                    throw ConfigError.invalidEntry(
                        "docker '\(name)' cannot define 'build' — only project and compose services support builds"
                    )
                }
                return .docker(DockerFields(
                    name: name,
                    image: image,
                    port: port,
                    url: rs.url,
                    scripts: Self.scriptsFromRaw(rs.scripts)
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
                    build: Self.buildFromRaw(rs.build, owner: "compose '\(name)'"),
                    scripts: Self.scriptsFromRaw(rs.scripts)
                ))

            default:
                throw ConfigError.invalidEntry("unknown service type '\(rs.type)'")
            }
        }

        return AppConfig(caddyfile: caddyfile, services: specs)
    }

    static func buildFromRaw(_ raw: RawBuild?, owner: String) -> BuildSpec? {
        guard let raw else { return nil }
        switch raw {
        case .single(let s):
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : .single(trimmed)
        case .multi(let items):
            let mapped = items
                .filter { !$0.name.isEmpty && !$0.command.isEmpty }
                .map { NamedCommand(name: $0.name, command: $0.command) }
            return mapped.isEmpty ? nil : .multi(mapped)
        }
    }

    static func scriptsFromRaw(_ raw: [RawNamedCommand]?) -> [NamedCommand] {
        (raw ?? [])
            .filter { !$0.name.isEmpty && !$0.command.isEmpty }
            .map { NamedCommand(name: $0.name, command: $0.command) }
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
