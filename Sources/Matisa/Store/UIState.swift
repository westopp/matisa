import Foundation

/// Persistent UI state — currently just which section headers are collapsed.
struct UIState: Codable, Sendable {
    var collapsedSections: Set<String> = []
}

enum UIStatePersistence {
    static func load() -> UIState {
        guard let data = try? Data(contentsOf: Paths.uiStateFile) else { return UIState() }
        return (try? JSONDecoder().decode(UIState.self, from: data)) ?? UIState()
    }

    static func save(_ state: UIState) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(state) else { return }
        try? data.write(to: Paths.uiStateFile, options: .atomic)
    }
}
