import Foundation

/// Cheap status snapshot for the Caddy reverse proxy. Mirrors what the app's
/// System panel needs to render: an at-a-glance "is caddy up?" indicator and
/// the configured Caddyfile path (for the open/reveal affordances). Lives in
/// MatisaCore so the engine emits the same shape the app already consumed.
public struct CaddyServiceInfo: Hashable, Sendable, Codable {
    public let running: Bool
    public let configFile: URL?

    public init(running: Bool, configFile: URL?) {
        self.running = running
        self.configFile = configFile
    }
}

/// Result of `caddy validate --config <path>`. `ok: false` carries the last
/// line of stderr in `message` so the UI can surface a one-liner; `ok: true`
/// leaves `message` nil. Same shape the app's status banners need.
public struct CaddyValidationResult: Codable, Sendable, Hashable {
    public let ok: Bool
    public let message: String?

    public init(ok: Bool, message: String?) {
        self.ok = ok
        self.message = message
    }
}
