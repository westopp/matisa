import SwiftUI
import AppKit

@main
struct MatisaApp: App {
    @State private var store = ServiceStore()

    init() {
        _ = Paths.supportDir
        _ = Paths.logsDir
        _ = Paths.configDir
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
