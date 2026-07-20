import Foundation

/// Lifecycle state of the Docker daemon (Docker Desktop or any compatible
/// provider). The engine probes during refresh and during action gating.
public enum DockerSystemState: Hashable, Sendable {
    case unknown                  // No probe yet (initial state)
    case running                  // Daemon answers `docker info`
    case stopped                  // Daemon not reachable
    case starting                 // We invoked `open -a Docker`, polling
    case startFailed(String)      // Polling timed out

    public var isRunning: Bool { if case .running = self { return true }; return false }
    public var isStarting: Bool { if case .starting = self { return true }; return false }
    public var isStartFailed: Bool { if case .startFailed = self { return true }; return false }
}

extension DockerSystemState: Codable {
    private enum Tag: String, Codable {
        case unknown, running, stopped, starting, startFailed
    }
    private enum CodingKeys: String, CodingKey { case type, message }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .unknown:       try c.encode(Tag.unknown, forKey: .type)
        case .running:       try c.encode(Tag.running, forKey: .type)
        case .stopped:       try c.encode(Tag.stopped, forKey: .type)
        case .starting:      try c.encode(Tag.starting, forKey: .type)
        case .startFailed(let m):
            try c.encode(Tag.startFailed, forKey: .type)
            try c.encode(m, forKey: .message)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let tag = try c.decode(Tag.self, forKey: .type)
        switch tag {
        case .unknown:     self = .unknown
        case .running:     self = .running
        case .stopped:     self = .stopped
        case .starting:    self = .starting
        case .startFailed: self = .startFailed(try c.decode(String.self, forKey: .message))
        }
    }
}

/// Captures the action a user tried to take when the daemon was found to be
/// down. Used by the alert flow to retry the original action once Docker is
/// up. Identifiable so SwiftUI's `.alert(item:)` can present it.
public struct PendingDockerPrompt: Hashable, Identifiable, Sendable {
    public let id: UUID
    public let serviceID: String
    public let serviceName: String
    public let action: ServiceAction

    public init(serviceID: String, serviceName: String, action: ServiceAction) {
        self.id = UUID()
        self.serviceID = serviceID
        self.serviceName = serviceName
        self.action = action
    }
}
