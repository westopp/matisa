import Foundation

enum Paths {
    static let bundleId = "dev.thulane.Matisa"

    static var supportDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent("Matisa", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var logsDir: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent("Library/Logs/Matisa", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var stateFile: URL {
        supportDir.appendingPathComponent("state.json")
    }

    /// Where the user's TS config lives.
    static var configDir: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent(".config/matisa", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var configFile: URL {
        configDir.appendingPathComponent("services.ts")
    }

    static func logFile(for serviceID: String) -> URL {
        let safe = serviceID
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "-")
        return logsDir.appendingPathComponent("\(safe).log")
    }

    /// Persistent UI state (collapsed sections, etc).
    static var uiStateFile: URL {
        supportDir.appendingPathComponent("ui-state.json")
    }
}
