import Foundation

/// One merged view of all services — what `services.snapshot` returns over
/// the wire. The engine produces this by combining the loaded `AppConfig`
/// with a `DiscoverySnapshot` and the on-disk `PersistedSpawn` records;
/// clients render it directly.
///
/// `dockerDaemonRunning` is duplicated from the underlying discovery snapshot
/// so callers can drive their daemon-state UI without a second round-trip.
public struct ServicesSnapshot: Codable, Hashable, Sendable {
    public let managed: [Service]
    public let unmanaged: [Service]
    public let dockerDaemonRunning: Bool
    public let takenAt: Date

    public init(
        managed: [Service],
        unmanaged: [Service],
        dockerDaemonRunning: Bool,
        takenAt: Date
    ) {
        self.managed = managed
        self.unmanaged = unmanaged
        self.dockerDaemonRunning = dockerDaemonRunning
        self.takenAt = takenAt
    }
}
