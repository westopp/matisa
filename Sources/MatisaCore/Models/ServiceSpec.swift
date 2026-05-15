import Foundation

/// What a service is, declaratively. Three managed types come from the user's
/// TS config; `unmanaged` is synthesised at runtime when we see a listening
/// dev process that isn't in the config.
public enum ServiceSpec: Hashable, Sendable {
    case project(ProjectFields)
    case docker(DockerFields)
    case compose(ComposeFields)
    case unmanaged(UnmanagedFields)
}

public struct ProjectFields: Hashable, Sendable, Codable {
    public let name: String
    public let path: URL
    public let port: Int
    public let url: String?
    public let command: String
    public let commands: [NamedCommand]
    public let group: String?
    public let env: EnvSpec?

    public init(
        name: String, path: URL, port: Int, url: String?, command: String,
        commands: [NamedCommand], group: String?, env: EnvSpec?
    ) {
        self.name = name; self.path = path; self.port = port; self.url = url
        self.command = command; self.commands = commands
        self.group = group; self.env = env
    }
}

public struct DockerFields: Hashable, Sendable, Codable {
    public let name: String
    public let image: String
    public let port: Int
    public let url: String?
    public let commands: [NamedCommand]
    public let group: String?

    public init(
        name: String, image: String, port: Int, url: String?,
        commands: [NamedCommand], group: String?
    ) {
        self.name = name; self.image = image; self.port = port; self.url = url
        self.commands = commands; self.group = group
    }
}

public struct ComposeFields: Hashable, Sendable, Codable {
    public let name: String
    public let file: URL
    public let ports: [ComposePort]
    public let commands: [NamedCommand]
    public let group: String?

    public init(
        name: String, file: URL, ports: [ComposePort],
        commands: [NamedCommand], group: String?
    ) {
        self.name = name; self.file = file; self.ports = ports
        self.commands = commands; self.group = group
    }
}

/// A named ad-hoc command attached to a service. The `name` is the menu
/// label (and also the dictionary key in the user's TS config).
public struct NamedCommand: Hashable, Sendable, Codable {
    public let name: String
    public let command: String
    public init(name: String, command: String) {
        self.name = name; self.command = command
    }
}

public struct ComposePort: Hashable, Sendable, Codable {
    public let host: Int
    public let url: String?
    public init(host: Int, url: String?) { self.host = host; self.url = url }
}

/// A single env var entry. Order is preserved from the user's TS config so
/// the UI can display vars in declaration order.
public struct EnvVar: Hashable, Sendable, Codable {
    public let name: String
    public let value: String
    public init(name: String, value: String) { self.name = name; self.value = value }
}

/// A named context (e.g. `dev`, `test`). When this context is the active
/// global selection, its vars layer on top of the base set.
public struct EnvContext: Hashable, Sendable, Codable {
    public let name: String
    public let vars: [EnvVar]
    public init(name: String, vars: [EnvVar]) { self.name = name; self.vars = vars }
}

/// Per-service env block. Strings at the top level become `base` vars
/// (always applied); object-valued top-level keys become named `contexts`
/// (applied as overlays when the matching context is active).
public struct EnvSpec: Hashable, Sendable, Codable {
    public let base: [EnvVar]
    public let contexts: [EnvContext]

    public var contextNames: [String] { contexts.map(\.name) }

    public var isEmpty: Bool { base.isEmpty && contexts.isEmpty }

    public init(base: [EnvVar], contexts: [EnvContext]) {
        self.base = base; self.contexts = contexts
    }

    /// Effective env to inject for the given active context. Base first,
    /// then the matching context overlays — more specific wins.
    public func effective(activeContext: String?) -> [String: String] {
        var dict: [String: String] = [:]
        for v in base { dict[v.name] = v.value }
        if let active = activeContext,
           let ctx = contexts.first(where: { $0.name == active }) {
            for v in ctx.vars { dict[v.name] = v.value }
        }
        return dict
    }

    /// All vars in the named context (without merging base). Used by the
    /// "Environment" pretty view when a non-default tab is selected.
    public func vars(in contextName: String) -> [EnvVar] {
        contexts.first(where: { $0.name == contextName })?.vars ?? []
    }
}

public enum UnmanagedKind: Hashable, Sendable {
    case process(pid: Int32, command: String, port: Int, appName: String?)
    case container(name: String, image: String, port: Int?)
}

extension UnmanagedKind: Codable {
    private enum Tag: String, Codable { case process, container }
    private enum CodingKeys: String, CodingKey {
        case type, pid, command, port, appName, name, image
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .process(pid, command, port, appName):
            try c.encode(Tag.process, forKey: .type)
            try c.encode(pid, forKey: .pid)
            try c.encode(command, forKey: .command)
            try c.encode(port, forKey: .port)
            try c.encodeIfPresent(appName, forKey: .appName)
        case let .container(name, image, port):
            try c.encode(Tag.container, forKey: .type)
            try c.encode(name, forKey: .name)
            try c.encode(image, forKey: .image)
            try c.encodeIfPresent(port, forKey: .port)
        }
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Tag.self, forKey: .type) {
        case .process:
            self = .process(
                pid: try c.decode(Int32.self, forKey: .pid),
                command: try c.decode(String.self, forKey: .command),
                port: try c.decode(Int.self, forKey: .port),
                appName: try c.decodeIfPresent(String.self, forKey: .appName)
            )
        case .container:
            self = .container(
                name: try c.decode(String.self, forKey: .name),
                image: try c.decode(String.self, forKey: .image),
                port: try c.decodeIfPresent(Int.self, forKey: .port)
            )
        }
    }
}

public struct UnmanagedFields: Hashable, Sendable, Codable {
    public let kind: UnmanagedKind
    public init(kind: UnmanagedKind) { self.kind = kind }

    public var displayName: String {
        switch kind {
        case let .process(_, command, _, appName): appName ?? command
        case let .container(name, _, _): name
        }
    }

    public var subtitle: String {
        switch kind {
        case let .process(pid, command, _, appName):
            appName != nil ? "\(command) · PID \(pid)" : "PID \(pid)"
        case let .container(_, image, _): image
        }
    }

    public var port: Int? {
        switch kind {
        case let .process(_, _, port, _): port
        case let .container(_, _, port): port
        }
    }

    public var pid: Int32? {
        if case let .process(pid, _, _, _) = kind { return pid }
        return nil
    }

    public var containerName: String? {
        if case let .container(name, _, _) = kind { return name }
        return nil
    }

    public var iconName: String {
        switch kind {
        case .process: "questionmark.circle"
        case .container: "shippingbox"
        }
    }
}

public enum ServiceKind: String, Hashable, Sendable, Codable {
    case project
    case docker
    case compose
    case unmanaged
}

extension ServiceSpec: Codable {
    private enum Tag: String, Codable { case project, docker, compose, unmanaged }
    private enum CodingKeys: String, CodingKey { case type, fields }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .project(let f):
            try c.encode(Tag.project, forKey: .type)
            try c.encode(f, forKey: .fields)
        case .docker(let f):
            try c.encode(Tag.docker, forKey: .type)
            try c.encode(f, forKey: .fields)
        case .compose(let f):
            try c.encode(Tag.compose, forKey: .type)
            try c.encode(f, forKey: .fields)
        case .unmanaged(let f):
            try c.encode(Tag.unmanaged, forKey: .type)
            try c.encode(f, forKey: .fields)
        }
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Tag.self, forKey: .type) {
        case .project:   self = .project(try c.decode(ProjectFields.self, forKey: .fields))
        case .docker:    self = .docker(try c.decode(DockerFields.self, forKey: .fields))
        case .compose:   self = .compose(try c.decode(ComposeFields.self, forKey: .fields))
        case .unmanaged: self = .unmanaged(try c.decode(UnmanagedFields.self, forKey: .fields))
        }
    }
}

public extension ServiceSpec {
    var kind: ServiceKind {
        switch self {
        case .project: .project
        case .docker: .docker
        case .compose: .compose
        case .unmanaged: .unmanaged
        }
    }

    var name: String {
        switch self {
        case .project(let f): f.name
        case .docker(let f): f.name
        case .compose(let f): f.name
        case .unmanaged(let f): f.displayName
        }
    }

    /// The single primary URL for this service, if any. For compose stacks
    /// returns the first declared port URL.
    var primaryURL: String? {
        switch self {
        case .project(let f): f.url
        case .docker(let f): f.url
        case .compose(let f): f.ports.first(where: { $0.url != nil })?.url
        case .unmanaged: nil
        }
    }

    /// All exposed (host port, optional url) pairs.
    var exposedPorts: [(port: Int, url: String?)] {
        switch self {
        case .project(let f): [(f.port, f.url)]
        case .docker(let f): [(f.port, f.url)]
        case .compose(let f): f.ports.map { ($0.host, $0.url) }
        case .unmanaged(let f):
            if let port = f.port { [(port, nil)] } else { [] }
        }
    }

    /// Ad-hoc named commands for this service. Empty when none configured.
    /// Builds, tests, lints — anything the user wants reachable from the
    /// command menu — all live here. There used to be a separate `build:`
    /// field; it was folded into commands so the model has one concept
    /// (named commands) instead of two with overlapping semantics.
    var commands: [NamedCommand] {
        switch self {
        case .project(let f): f.commands
        case .docker(let f): f.commands
        case .compose(let f): f.commands
        case .unmanaged: []
        }
    }

    /// Group name as declared in config. Trimmed and non-empty when present.
    /// `nil` for ungrouped services and unmanaged entries.
    var group: String? {
        switch self {
        case .project(let f): f.group
        case .docker(let f): f.group
        case .compose(let f): f.group
        case .unmanaged: nil
        }
    }

    /// Configured env block, if any. Only project services support env in
    /// v1 — docker/compose users wire their own via `-e` / compose YAML.
    var env: EnvSpec? {
        switch self {
        case .project(let f): f.env
        case .docker, .compose, .unmanaged: nil
        }
    }

    /// Working directory for build/script invocations. Falls back to the
    /// user's home for services without a natural cwd (e.g. plain docker).
    var workingDirectory: URL {
        switch self {
        case .project(let f): f.path
        case .compose(let f): f.file.deletingLastPathComponent()
        case .docker, .unmanaged:
            FileManager.default.homeDirectoryForCurrentUser
        }
    }
}
