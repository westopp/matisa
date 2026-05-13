import Foundation

public enum ServiceState: Hashable, Sendable {
    case stopped
    case starting
    case running(pid: Int32, since: Date)
    case stopping
    case unmanaged(pid: Int32)
    case error(String)

    public var isRunning: Bool {
        switch self {
        case .running, .unmanaged, .starting, .stopping: return true
        case .stopped, .error: return false
        }
    }

    public var isStable: Bool {
        switch self {
        case .running, .unmanaged, .stopped, .error: return true
        case .starting, .stopping: return false
        }
    }

    public var pid: Int32? {
        switch self {
        case .running(let pid, _), .unmanaged(let pid): return pid
        default: return nil
        }
    }

    public var label: String {
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

extension ServiceState: Codable {
    private enum Tag: String, Codable {
        case stopped, starting, running, stopping, unmanaged, error
    }
    private enum CodingKeys: String, CodingKey {
        case type, pid, since, message
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .stopped:  try c.encode(Tag.stopped, forKey: .type)
        case .starting: try c.encode(Tag.starting, forKey: .type)
        case .running(let pid, let since):
            try c.encode(Tag.running, forKey: .type)
            try c.encode(pid, forKey: .pid)
            try c.encode(since, forKey: .since)
        case .stopping: try c.encode(Tag.stopping, forKey: .type)
        case .unmanaged(let pid):
            try c.encode(Tag.unmanaged, forKey: .type)
            try c.encode(pid, forKey: .pid)
        case .error(let msg):
            try c.encode(Tag.error, forKey: .type)
            try c.encode(msg, forKey: .message)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Tag.self, forKey: .type) {
        case .stopped:   self = .stopped
        case .starting:  self = .starting
        case .running:
            self = .running(
                pid: try c.decode(Int32.self, forKey: .pid),
                since: try c.decode(Date.self, forKey: .since)
            )
        case .stopping:  self = .stopping
        case .unmanaged: self = .unmanaged(pid: try c.decode(Int32.self, forKey: .pid))
        case .error:     self = .error(try c.decode(String.self, forKey: .message))
        }
    }
}
