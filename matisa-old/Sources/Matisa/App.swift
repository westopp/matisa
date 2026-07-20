import SwiftUI
import AppKit
import MatisaCore

@main
struct MatisaApp: App {
    @State private var store = ServiceStore()

    init() {
        _ = Paths.supportDir
        _ = Paths.logsDir
        _ = Paths.configDir

        // Spawn the engine eagerly. Fire-and-forget: the engine is the
        // single source of truth when it's up, but the app's local-fallback
        // path keeps things working if the spawn fails (e.g. dev box where
        // the binary hasn't been built). Logged but not surfaced — the UI
        // will degrade visibly via the Engine row in the System group.
        Task {
            do {
                _ = try await EngineLauncher.ensureRunning(
                    socketPath: EngineClient.defaultSocketPath()
                )
            } catch {
                FileHandle.standardError.write(
                    Data("Matisa: engine spawn failed: \(error)\n".utf8)
                )
            }
        }
    }

    var body: some Scene {
        Window("Matisa", id: "main") {
            MainWindowView()
                .environment(store)
                .frame(minWidth: 880, minHeight: 540)
                .task { await store.bootstrap() }
        }
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) { }
            CommandGroup(replacing: .help) { }
        }
    }
}
