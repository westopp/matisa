import Foundation

/// One running process the engine spawned and tracks across restarts. Persisted
/// to `CorePaths.stateFile` so reconnecting to a service after the app reopens
/// preserves the .running state instead of falling back to "something is on
/// that port, treat as unmanaged."
public struct PersistedSpawn: Codable, Hashable, Sendable {
    public let serviceID: String
    public let pid: Int32
    public let port: Int?
    public let startedAt: Date
    public let logPath: String

    public init(
        serviceID: String,
        pid: Int32,
        port: Int?,
        startedAt: Date,
        logPath: String
    ) {
        self.serviceID = serviceID
        self.pid = pid
        self.port = port
        self.startedAt = startedAt
        self.logPath = logPath
    }
}

/// Top-level shape of `state.json`. `version` lets us evolve the on-disk
/// format without breaking older readers.
public struct PersistedState: Codable, Hashable, Sendable {
    public var version: Int
    public var spawns: [PersistedSpawn]

    public init(version: Int = 1, spawns: [PersistedSpawn] = []) {
        self.version = version
        self.spawns = spawns
    }
}
