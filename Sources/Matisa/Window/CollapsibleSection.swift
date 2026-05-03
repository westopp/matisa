import SwiftUI
import Combine

/// Section header with a chevron that toggles its content. Collapsed state is
/// persisted across launches via `UIStatePersistence`.
struct CollapsibleSection<Content: View>: View {
    let id: String
    let title: String
    let count: Int
    @ViewBuilder let content: () -> Content

    @State private var collapsed: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { collapsed.toggle() }
                persist()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 10)
                    Text(title)
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(.secondary)
                    Text("\(count)")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background {
                            Capsule().fill(Color.primary.opacity(0.06))
                        }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !collapsed {
                content()
            }
        }
        .onAppear {
            collapsed = UIStatePersistence.load().collapsedSections.contains(id)
            reportToRegistry(isCollapsed: collapsed)
        }
        .onDisappear {
            forgetFromRegistry()
        }
        .onReceive(NotificationCenter.default.publisher(for: .collapsibleSectionsCollapseAll)) { _ in
            guard !collapsed else { return }
            withAnimation(.easeInOut(duration: 0.18)) { collapsed = true }
            persist()
        }
        .onReceive(NotificationCenter.default.publisher(for: .collapsibleSectionsExpandAll)) { _ in
            guard collapsed else { return }
            withAnimation(.easeInOut(duration: 0.18)) { collapsed = false }
            persist()
        }
    }

    private func persist() {
        var state = UIStatePersistence.load()
        if collapsed { state.collapsedSections.insert(id) }
        else { state.collapsedSections.remove(id) }
        UIStatePersistence.save(state)
        reportToRegistry(isCollapsed: collapsed)
    }

    /// Registry mutations are deferred to the next runloop tick so they land
    /// after any active SwiftUI animation transaction (e.g. a parent section
    /// expanding and synchronously mounting/unmounting nested children).
    /// Otherwise the resulting invalidation of `anyExpanded` is observed by
    /// the sidebar header inside the animation, which makes unrelated
    /// sibling sections appear to animate in sympathy.
    private func reportToRegistry(isCollapsed: Bool) {
        let id = self.id
        DispatchQueue.main.async {
            CollapsibleSectionRegistry.shared.report(id: id, isCollapsed: isCollapsed)
        }
    }

    private func forgetFromRegistry() {
        let id = self.id
        DispatchQueue.main.async {
            CollapsibleSectionRegistry.shared.forget(id: id)
        }
    }
}
