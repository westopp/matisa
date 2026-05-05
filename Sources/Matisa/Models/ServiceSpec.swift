import Foundation

/// What a service is, declaratively. Three managed types come from the user's
/// TS config; `unmanaged` is synthesised at runtime when we see a listening
/// dev process that isn't in the config.
enum ServiceSpec: Hashable, Sendable {
    case project(ProjectFields)
    case docker(DockerFields)
    case compose(ComposeFields)
    case unmanaged(UnmanagedFields)
}

struct ProjectFields: Hashable, Sendable {
    let name: String
    let path: URL
    let port: Int
    let url: String?
    let command: String
    let build: BuildSpec?
    let scripts: [NamedCommand]
    let group: String?
    let env: EnvSpec?
}

struct DockerFields: Hashable, Sendable {
    let name: String
    let image: String
    let port: Int
    let url: String?
    let scripts: [NamedCommand]
    let group: String?
}

struct ComposeFields: Hashable, Sendable {
    let name: String
    let file: URL
    let ports: [ComposePort]
    let build: BuildSpec?
    let scripts: [NamedCommand]
    let group: String?
}

/// A named ad-hoc command attached to a service. The `name` is the menu
/// label (and also the dictionary key in the user's TS config).
struct NamedCommand: Hashable, Sendable {
    let name: String
    let command: String
}

/// Build configuration. `single` runs directly when the build icon is tapped;
/// `multi` opens a context menu of named commands.
enum BuildSpec: Hashable, Sendable {
    case single(String)
    case multi([NamedCommand])
}

struct ComposePort: Hashable, Sendable {
    let host: Int
    let url: String?
}

/// A single env var entry. Order is preserved from the user's TS config so
/// the UI can display vars in declaration order.
struct EnvVar: Hashable, Sendable {
    let name: String
    let value: String
}

/// A named context (e.g. `dev`, `test`). When this context is the active
/// global selection, its vars layer on top of the base set.
struct EnvContext: Hashable, Sendable {
    let name: String
    let vars: [EnvVar]
}

/// Per-service env block. Strings at the top level become `base` vars
/// (always applied); object-valued top-level keys become named `contexts`
/// (applied as overlays when the matching context is active).
struct EnvSpec: Hashable, Sendable {
    let base: [EnvVar]
    let contexts: [EnvContext]

    var contextNames: [String] { contexts.map(\.name) }

    var isEmpty: Bool { base.isEmpty && contexts.isEmpty }

    /// Effective env to inject for the given active context. Base first,
    /// then the matching context overlays — more specific wins.
    func effective(activeContext: String?) -> [String: String] {
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
    func vars(in contextName: String) -> [EnvVar] {
        contexts.first(where: { $0.name == contextName })?.vars ?? []
    }
}

enum UnmanagedKind: Hashable, Sendable {
    case process(pid: Int32, command: String, port: Int, appName: String?)
    case container(name: String, image: String, port: Int?)
}

struct UnmanagedFields: Hashable, Sendable {
    let kind: UnmanagedKind

    var displayName: String {
        switch kind {
        case let .process(_, command, _, appName): appName ?? command
        case let .container(name, _, _): name
        }
    }

    var subtitle: String {
        switch kind {
        case let .process(pid, command, _, appName):
            appName != nil ? "\(command) · PID \(pid)" : "PID \(pid)"
        case let .container(_, image, _): image
        }
    }

    var port: Int? {
        switch kind {
        case let .process(_, _, port, _): port
        case let .container(_, _, port): port
        }
    }

    var pid: Int32? {
        if case let .process(pid, _, _, _) = kind { return pid }
        return nil
    }

    var containerName: String? {
        if case let .container(name, _, _) = kind { return name }
        return nil
    }

    var iconName: String {
        switch kind {
        case .process: "questionmark.circle"
        case .container: "shippingbox"
        }
    }
}

enum ServiceKind: String, Hashable, Sendable {
    case project
    case docker
    case compose
    case unmanaged
}

extension ServiceSpec {
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

    /// Build configuration, if defined for this service. Only project and
    /// compose services support builds.
    var build: BuildSpec? {
        switch self {
        case .project(let f): f.build
        case .compose(let f): f.build
        case .docker, .unmanaged: nil
        }
    }

    /// Ad-hoc named commands for this service. Empty when none configured.
    var scripts: [NamedCommand] {
        switch self {
        case .project(let f): f.scripts
        case .docker(let f): f.scripts
        case .compose(let f): f.scripts
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
