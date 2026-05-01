import Foundation

struct Service: Identifiable, Hashable, Sendable {
    let spec: ServiceSpec
    var state: ServiceState
    var logsPath: URL?

    var id: String {
        switch spec {
        case .project(let f):   "project:\(f.name)"
        case .docker(let f):    "docker:\(f.name)"
        case .compose(let f):   "compose:\(f.name)"
        case .unmanaged(let f):
            switch f.kind {
            case let .process(pid, _, _):     "unmanaged:proc:\(pid)"
            case let .container(name, _, _):  "unmanaged:cont:\(name)"
            }
        }
    }

    var name: String { spec.name }
    var kind: ServiceKind { spec.kind }

    /// True when the service is running but the running process is not under
    /// our supervision (started outside Matisa).
    var isRunningUnmanaged: Bool {
        if case .unmanaged = state { return true }
        return false
    }
}
