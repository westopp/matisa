import Foundation
import Darwin

/// Locates and starts the matisa-engine binary on behalf of the app.
///
/// The engine is normally spawned by the app at launch if the socket
/// isn't reachable, and is left running detached so it outlives the app
/// (the locked-in design — see plan.md). The launcher only spawns; the
/// engine's own flock on `<sock>.lock` (Server.swift) is the single-
/// instance guard, so spawning is safe even if a race produces two
/// concurrent attempts.
enum EngineLauncher {

    /// Resolution order:
    /// 1. `MATISA_ENGINE_BINARY` — env override, used by tests and as an
    ///    escape hatch for unusual dev setups.
    /// 2. Sibling of the running executable
    ///    (`Contents/MacOS/matisa-engine` inside the shipped `.app`).
    /// 3. `.build/<config>/matisa-engine` for `swift run` dev workflow.
    static func resolveBinaryURL() -> URL? {
        if let envPath = ProcessInfo.processInfo.environment["MATISA_ENGINE_BINARY"],
           !envPath.isEmpty,
           FileManager.default.isExecutableFile(atPath: envPath) {
            return URL(fileURLWithPath: envPath)
        }

        // Sibling of the running executable. Bundle.main resolves to the
        // .app bundle URL for app builds, so we go up to MacOS/ and look
        // for matisa-engine there. For SPM test binaries Bundle.main is
        // the test runner — sibling lookup will miss, which is fine; the
        // .build fallback below kicks in.
        if let exec = Bundle.main.executableURL {
            let sibling = exec
                .deletingLastPathComponent()
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: sibling.path) {
                return sibling
            }
        }

        // .build/<config>/matisa-engine for `swift run` development.
        // CWD when running the app via swift run is the package root.
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for config in ["debug", "release"] {
            let candidate = cwd
                .appendingPathComponent(".build")
                .appendingPathComponent(config)
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }

        return nil
    }
}
