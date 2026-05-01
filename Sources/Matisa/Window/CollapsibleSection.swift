import SwiftUI

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
        }
    }

    private func persist() {
        var state = UIStatePersistence.load()
        if collapsed { state.collapsedSections.insert(id) }
        else { state.collapsedSections.remove(id) }
        UIStatePersistence.save(state)
    }
}
