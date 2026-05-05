import SwiftUI
import Combine

/// Section header with a chevron that toggles its content. Collapsed state is
/// persisted across launches via `UIStatePersistence`.
struct CollapsibleSection<Trailing: View, Content: View>: View {
    let id: String
    let title: String
    let count: Int
    let trailing: () -> Trailing
    @ViewBuilder let content: () -> Content

    @State private var collapsed: Bool = false

    init(
        id: String,
        title: String,
        count: Int,
        @ViewBuilder trailing: @escaping () -> Trailing,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.id = id
        self.title = title
        self.count = count
        self.trailing = trailing
        self.content = content

        // Seed `collapsed` from persistence so the first frame is correct.
        // Without this, sections that remount (e.g. detail view via `.id(svc.id)`
        // on selection change) flash open then snap shut on .onAppear.
        let state = UIStatePersistence.load()
        let initial = state.collapsedSections.contains(id) || state.collapseByDefault
        _collapsed = State(initialValue: initial)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Button {
                    setCollapsed(!collapsed)
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

                trailing()
            }

            if !collapsed {
                content()
                    .transition(.asymmetric(
                        insertion: .opacity.animation(.easeOut(duration: 0.08).delay(0.14)),
                        removal:   .opacity.animation(.easeIn(duration: 0.08))
                    ))
            }
        }
        .onAppear {
            // `collapsed` was seeded in init. We only need to persist the
            // implicit collapse here (so future loads don't have to recompute
            // collapseByDefault) and report current state to the registry.
            var state = UIStatePersistence.load()
            if state.collapseByDefault, !state.collapsedSections.contains(id) {
                state.collapsedSections.insert(id)
                UIStatePersistence.save(state)
            }
            reportToRegistry(isCollapsed: collapsed)
        }
        .onDisappear {
            forgetFromRegistry()
        }
        .onReceive(NotificationCenter.default.publisher(for: .collapsibleSectionsCollapseAll)) { _ in
            guard !collapsed else { return }
            setCollapsed(true)
            persist()
        }
        .onReceive(NotificationCenter.default.publisher(for: .collapsibleSectionsExpandAll)) { _ in
            guard collapsed else { return }
            setCollapsed(false)
            persist()
        }
    }

    /// Container resize is staged so it only runs while the content is *not*
    /// occupying space: on collapse it waits for the content's fade-out, on
    /// expand it runs first and the content fades in afterwards. Keeping the
    /// resize and the fade in separate phases stops the outer ScrollView from
    /// snapshotting sibling positions against a half-mounted subtree, which
    /// is what otherwise makes sections below appear to slide in from the
    /// top of this section.
    private func setCollapsed(_ newValue: Bool) {
        let willCollapse = newValue
        withAnimation(
            willCollapse
                ? .easeInOut(duration: 0.14).delay(0.08)
                : .easeInOut(duration: 0.14)
        ) {
            collapsed = newValue
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

extension CollapsibleSection where Trailing == EmptyView {
    init(
        id: String,
        title: String,
        count: Int,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            id: id,
            title: title,
            count: count,
            trailing: { EmptyView() },
            content: content
        )
    }
}
