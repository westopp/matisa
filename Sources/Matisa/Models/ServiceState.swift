import Foundation

enum ServiceState: Hashable, Sendable {
    case stopped
    case starting
    case running(pid: Int32, since: Date)
    case stopping
    case unmanaged(pid: Int32)
    case error(String)

    var isRunning: Bool {
        switch self {
        case .running, .unmanaged, .starting, .stopping: return true
        case .stopped, .error: return false
        }
    }

    var isStable: Bool {
        switch self {
        case .running, .unmanaged, .stopped, .error: return true
        case .starting, .stopping: return false
        }
    }

    var pid: Int32? {
        switch self {
        case .running(let pid, _), .unmanaged(let pid): return pid
        default: return nil
        }
    }

    var label: String {
        switch self {
        case .stopped: return "Stopped"
        case .starting: return "Starting…"
        case .running: return "Running"
        case .stopping: return "Stopping…"
        case .unmanaged: return "Unmanaged"
        case .error(let msg): return "Error: \(msg)"
        }
    }
}
