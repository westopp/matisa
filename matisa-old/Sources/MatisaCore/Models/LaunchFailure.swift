import Foundation

/// Captured by the engine's launch-watcher when a project service dies
/// shortly after spawn. Carries enough context to tell the user *why* the
/// process didn't survive — the time it lived plus the tail of the log file.
/// Transient: never persisted across app runs (the log file on disk is the
/// durable record).
public struct LaunchFailure: Hashable, Sendable, Codable {

    /// When we noticed the process had died.
    public let failedAt: Date

    /// Wall-clock seconds the process was alive before it exited.
    public let aliveSeconds: TimeInterval

    /// Last few lines of stdout/stderr captured to the service's log file.
    /// May be empty if the log was empty or unreadable.
    public let logTail: String

    /// Single-line summary suitable for `ServiceState.error(String)` and
    /// the sidebar tooltip — e.g. `"exited after 0.4s: bash: vite: command
    /// not found"`. Derived from the last non-blank log line.
    public let summary: String

    public init(failedAt: Date, aliveSeconds: TimeInterval, logTail: String, summary: String) {
        self.failedAt = failedAt
        self.aliveSeconds = aliveSeconds
        self.logTail = logTail
        self.summary = summary
    }
}

/// Wire shape for `launch_failures.list`. Wraps the map so the JSON-RPC
/// `result` is always an object (some clients reject top-level dicts when
/// they're expecting a record-shaped response).
public struct LaunchFailuresList: Codable, Sendable {
    public let failures: [String: LaunchFailure]
    public init(failures: [String: LaunchFailure]) {
        self.failures = failures
    }
}
