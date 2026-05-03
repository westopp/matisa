import Foundation
import Observation

/// Persistent UI state — currently just which section headers are collapsed.
struct UIState: Codable, Sendable {
    var collapsedSections: Set<String> = []
}

/// Live in-memory tracker of currently mounted CollapsibleSections and their
/// expanded/collapsed state. Lets the toolbar derive a single "is anything
/// expanded?" signal without enumerating IDs at the call site.
@MainActor
@Observable
final class CollapsibleSectionRegistry {
    static let shared = CollapsibleSectionRegistry()
    private(set) var expandedIDs: Set<String> = []

    func report(id: String, isCollapsed: Bool) {
        if isCollapsed { expandedIDs.remove(id) }
        else { expandedIDs.insert(id) }
    }

    func forget(id: String) {
        expandedIDs.remove(id)
    }

    var anyExpanded: Bool { !expandedIDs.isEmpty }
}

/// Broadcast fan-out for the "collapse / expand all sections" toolbar action.
/// CollapsibleSection observes these and updates + persists its own state.
extension Notification.Name {
    static let collapsibleSectionsCollapseAll = Notification.Name("matisa.collapsibleSections.collapseAll")
    static let collapsibleSectionsExpandAll = Notification.Name("matisa.collapsibleSections.expandAll")
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
