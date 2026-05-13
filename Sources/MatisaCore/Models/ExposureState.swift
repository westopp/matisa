import Foundation

/// Public-tunnel (sish) status for a single service.
public enum PublicTunnelStatus: Hashable, Sendable {
    case idle
    case connecting
    case live(url: String)
    case disconnected
    case error(String)

    public var isActive: Bool {
        switch self {
        case .connecting, .live: true
        default: false
        }
    }

    public var url: String? {
        if case let .live(url) = self { return url }
        return nil
    }
}

/// Wire shape for `exposure.public_tunnel.list` — wraps the service id →
/// status map so the JSON-RPC `result` is always an object. The engine
/// returns the full per-service map (including idle entries that were ever
/// active and haven't been cleared); the app's local TunnelManager mirrors
/// the contents while preserving locally-spawned entries.
public struct PublicTunnelStatusList: Codable, Sendable {
    public let statuses: [String: PublicTunnelStatus]

    public init(statuses: [String: PublicTunnelStatus]) {
        self.statuses = statuses
    }
}

extension PublicTunnelStatus: Codable {
    private enum Tag: String, Codable { case idle, connecting, live, disconnected, error }
    private enum CodingKeys: String, CodingKey { case type, url, message }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .idle:         try c.encode(Tag.idle, forKey: .type)
        case .connecting:   try c.encode(Tag.connecting, forKey: .type)
        case .live(let u):
            try c.encode(Tag.live, forKey: .type)
            try c.encode(u, forKey: .url)
        case .disconnected: try c.encode(Tag.disconnected, forKey: .type)
        case .error(let m):
            try c.encode(Tag.error, forKey: .type)
            try c.encode(m, forKey: .message)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Tag.self, forKey: .type) {
        case .idle:         self = .idle
        case .connecting:   self = .connecting
        case .live:         self = .live(url: try c.decode(String.self, forKey: .url))
        case .disconnected: self = .disconnected
        case .error:        self = .error(try c.decode(String.self, forKey: .message))
        }
    }
}

/// Same-network (mDNS + local Caddy) status for a single service.
public enum SameNetworkStatus: Hashable, Sendable {
    case idle
    case advertising(hostname: String)
    case active(hostname: String)
    case error(String)

    public var isActive: Bool {
        switch self {
        case .advertising, .active: true
        default: false
        }
    }

    public var hostname: String? {
        switch self {
        case let .advertising(h), let .active(h): h
        default: nil
        }
    }
}

/// Wire shape for `exposure.same_network.list` — wraps the service id →
/// status map so the JSON-RPC `result` is always an object. Mirrors
/// `PublicTunnelStatusList`. The engine returns the full per-service map
/// (including idle entries that were ever active and haven't been
/// cleared); the app's local MDNSPublisher mirrors the contents while
/// preserving locally-spawned entries.
public struct SameNetworkStatusList: Codable, Sendable {
    public let statuses: [String: SameNetworkStatus]

    public init(statuses: [String: SameNetworkStatus]) {
        self.statuses = statuses
    }
}

extension SameNetworkStatus: Codable {
    private enum Tag: String, Codable { case idle, advertising, active, error }
    private enum CodingKeys: String, CodingKey { case type, hostname, message }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .idle: try c.encode(Tag.idle, forKey: .type)
        case .advertising(let h):
            try c.encode(Tag.advertising, forKey: .type)
            try c.encode(h, forKey: .hostname)
        case .active(let h):
            try c.encode(Tag.active, forKey: .type)
            try c.encode(h, forKey: .hostname)
        case .error(let m):
            try c.encode(Tag.error, forKey: .type)
            try c.encode(m, forKey: .message)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Tag.self, forKey: .type) {
        case .idle:        self = .idle
        case .advertising: self = .advertising(hostname: try c.decode(String.self, forKey: .hostname))
        case .active:      self = .active(hostname: try c.decode(String.self, forKey: .hostname))
        case .error:       self = .error(try c.decode(String.self, forKey: .message))
        }
    }
}

/// Combined exposure state for one service. Stored on the engine keyed by
/// service id so the lifecycle `ServiceState` enum stays untouched.
public struct ServiceExposure: Hashable, Sendable, Codable {
    public var publicTunnel: PublicTunnelStatus
    public var sameNetwork: SameNetworkStatus

    public var hasAnyActive: Bool { publicTunnel.isActive || sameNetwork.isActive }

    public init(
        publicTunnel: PublicTunnelStatus = .idle,
        sameNetwork: SameNetworkStatus = .idle
    ) {
        self.publicTunnel = publicTunnel
        self.sameNetwork = sameNetwork
    }
}
