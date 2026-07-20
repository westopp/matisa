import Foundation

public struct Service: Identifiable, Hashable, Sendable, Codable {
    public let spec: ServiceSpec
    public var state: ServiceState
    public var logsPath: URL?

    public init(spec: ServiceSpec, state: ServiceState, logsPath: URL?) {
        self.spec = spec
        self.state = state
        self.logsPath = logsPath
    }

    public var id: String {
        switch spec {
        case .project(let f):   "project:\(f.name)"
        case .docker(let f):    "docker:\(f.name)"
        case .compose(let f):   "compose:\(f.name)"
        case .unmanaged(let f):
            switch f.kind {
            case let .process(pid, _, _, _):  "unmanaged:proc:\(pid)"
            case let .container(name, _, _):  "unmanaged:cont:\(name)"
            }
        }
    }

    public var name: String { spec.name }
    public var kind: ServiceKind { spec.kind }

    /// True when the service is running but the running process is not under
    /// our supervision (started outside Matisa).
    public var isRunningUnmanaged: Bool {
        if case .unmanaged = state { return true }
        return false
    }
}
