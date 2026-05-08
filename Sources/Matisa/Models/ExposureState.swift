import Foundation

/// Public-tunnel (sish) status for a single service.
enum PublicTunnelStatus: Hashable, Sendable {
    case idle
    case connecting
    case live(url: String)
    case disconnected
    case error(String)

    var isActive: Bool {
        switch self {
        case .connecting, .live: true
        default: false
        }
    }

    var url: String? {
        if case let .live(url) = self { return url }
        return nil
    }
}

/// Same-network (mDNS + local Caddy) status for a single service.
enum SameNetworkStatus: Hashable, Sendable {
    case idle
    case advertising(hostname: String)
    case active(hostname: String)
    case error(String)

    var isActive: Bool {
        switch self {
        case .advertising, .active: true
        default: false
        }
    }

    var hostname: String? {
        switch self {
        case let .advertising(h), let .active(h): h
        default: nil
        }
    }
}

/// Combined exposure state for one service. Stored on `ServiceStore` keyed by
/// service id so the lifecycle `ServiceState` enum stays untouched.
struct ServiceExposure: Hashable, Sendable {
    var publicTunnel: PublicTunnelStatus = .idle
    var sameNetwork: SameNetworkStatus = .idle

    var hasAnyActive: Bool { publicTunnel.isActive || sameNetwork.isActive }
}
