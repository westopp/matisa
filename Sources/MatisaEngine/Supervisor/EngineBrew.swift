import Foundation

/// Async sibling to `SyncBrew` for the lifecycle (write) side of brew services.
/// `SyncBrew.list()` already covers the discovery snapshot's read; this enum
/// adds the action methods the engine needs to drive Caddy start/stop/restart
/// through `brew services`.
///
/// Each method shells out to `brew services <verb> <name>` with a 60s timeout.
/// `brew services start` can be slow on first run (it lays down the LaunchAgent
/// plist and waits for the agent to come up); the previous app-side
/// `BrewServices` had no explicit timeout — 60s matches what users tolerate
/// before they reach for the menu themselves.
enum EngineBrew {
    static var brewPath: String { SyncShell.which("brew") ?? "/opt/homebrew/bin/brew" }

    static func start(_ name: String) async throws {
        _ = try await EngineShell.run(
            executable: brewPath,
            arguments: ["services", "start", name],
            timeout: 60
        )
    }

    static func stop(_ name: String) async throws {
        _ = try await EngineShell.run(
            executable: brewPath,
            arguments: ["services", "stop", name],
            timeout: 60
        )
    }

    static func restart(_ name: String) async throws {
        _ = try await EngineShell.run(
            executable: brewPath,
            arguments: ["services", "restart", name],
            timeout: 60
        )
    }
}
