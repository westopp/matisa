import Foundation
import MatisaCore

/// App-side path helpers. The shared, engine/app-cross paths live in
/// `MatisaCore.CorePaths` so both targets resolve identical locations; this
/// enum re-exports them and adds the config-specific paths that only the app
/// (and ConfigService inside the engine) cares about.
enum Paths {
    static let bundleId = "dev.thulane.Matisa"

    static var supportDir: URL { CorePaths.supportDir }
    static var logsDir: URL { CorePaths.logsDir }
    static var stateFile: URL { CorePaths.stateFile }
    static func logFile(for serviceID: String) -> URL { CorePaths.logFile(for: serviceID) }

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

    /// Persistent UI state (collapsed sections, etc).
    static var uiStateFile: URL {
        supportDir.appendingPathComponent("ui-state.json")
    }
}
