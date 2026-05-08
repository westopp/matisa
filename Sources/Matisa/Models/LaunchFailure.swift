import Foundation

/// Captured by `ServiceStore`'s launch-watcher when a project service dies
/// shortly after spawn. Carries enough context to tell the user *why* the
/// process didn't survive — the time it lived plus the tail of the log file.
/// Transient: lives in the store, never persisted across app runs (the log
/// file on disk is the durable record).
struct LaunchFailure: Hashable, Sendable {
    /// When we noticed the process had died.
    let failedAt: Date

    /// Wall-clock seconds the process was alive before it exited.
    let aliveSeconds: TimeInterval

    /// Last few lines of stdout/stderr captured to the service's log file.
    /// May be empty if the log was empty or unreadable.
    let logTail: String

    /// Single-line summary suitable for `ServiceState.error(String)` and
    /// the sidebar tooltip — e.g. `"exited after 0.4s: bash: vite: command
    /// not found"`. Derived from the last non-blank log line.
    let summary: String
}
