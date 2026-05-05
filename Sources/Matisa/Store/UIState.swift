import Foundation
import Observation

/// Persistent UI state — which section headers are collapsed, plus a sticky
/// "collapse by default" flag for sections that haven't mounted yet.
struct UIState: Codable, Sendable {
    var collapsedSections: Set<String> = []
    /// Set by Collapse All so sections that weren't yet in the view tree at
    /// the time of the bulk action still come up collapsed when they finally
    /// appear (e.g. a nested group inside a section that was itself
    /// collapsed). Cleared by Expand All.
    var collapseByDefault: Bool = false
    /// Globally selected env context name. `nil` means no overlay — only
    /// base env vars are injected. Survives app restart.
    var activeEnvContext: String? = nil

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.collapsedSections = try container.decodeIfPresent(Set<String>.self, forKey: .collapsedSections) ?? []
        self.collapseByDefault = try container.decodeIfPresent(Bool.self, forKey: .collapseByDefault) ?? false
        self.activeEnvContext = try container.decodeIfPresent(String.self, forKey: .activeEnvContext)
    }

    private enum CodingKeys: String, CodingKey {
        case collapsedSections
        case collapseByDefault
        case activeEnvContext
    }
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
