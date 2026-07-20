import Foundation

/// File-system locations shared between the engine and the app. Anything that
/// crosses target boundaries (the state file the engine reads, the log files
/// the supervisor writes) lives here so both targets resolve the same paths.
///
/// The app's `Paths` keeps user-config-specific helpers (e.g. the TS config
/// dir under `~/.config/matisa`) and re-exports these for source compatibility.
public enum CorePaths {

    /// `~/Library/Application Support/Matisa/`. Created on first access.
    public static var supportDir: URL {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first!
        let dir = base.appendingPathComponent("Matisa", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// `~/Library/Logs/Matisa/`. Created on first access.
    public static var logsDir: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent("Library/Logs/Matisa", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Persisted spawn records. App writes today; engine reads (and will write
    /// after Phase 2c moves lifecycle into the engine).
    public static var stateFile: URL {
        supportDir.appendingPathComponent("state.json")
    }

    /// Per-service log file path. Service ids contain `:` and `/` which aren't
    /// safe filename characters — the same substitution must run in both
    /// targets so the engine and the app write/read the same file.
    public static func logFile(for serviceID: String) -> URL {
        let safe = serviceID
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "-")
        return logsDir.appendingPathComponent("\(safe).log")
    }
}
