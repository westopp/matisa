import SwiftUI

/// Compact menu-style picker that selects the globally active env context.
/// Shows the active context (or "default" when none) and is shared by the
/// row-level placement and the detail-pane Environment section.
struct EnvContextPicker: View {
    @Environment(ServiceStore.self) private var store
    /// When provided, the menu only lists contexts declared on this service.
    /// `nil` means show every context discovered across all services.
    var scope: EnvSpec? = nil

    private var options: [String] {
        if let scope { scope.contextNames }
        else { store.availableEnvContexts }
    }

    var body: some View {
        let active = store.activeEnvContext
        Menu {
            Button {
                store.setActiveEnvContext(nil)
            } label: {
                if active == nil { Label("default", systemImage: "checkmark") }
                else { Text("default") }
            }
            if !options.isEmpty {
                Divider()
                ForEach(options, id: \.self) { name in
                    Button {
                        store.setActiveEnvContext(name)
                    } label: {
                        if active == name { Label(name, systemImage: "checkmark") }
                        else { Text(name) }
                    }
                }
            }
        } label: {
            Text(active ?? "default")
                .font(.caption.weight(.medium))
                .lineLimit(1)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.10))
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Active env context")
    }
}

/// "Environment" CollapsibleSection rendered in `ServiceDetailView`. Shows a
/// tab strip across the configured contexts, with the picker mirrored in
/// the section header so the user can switch contexts without expanding.
struct EnvironmentSection: View {
    @Environment(ServiceStore.self) private var store
    let serviceID: String
    let env: EnvSpec

    /// Tab the user is currently *viewing* in the section. Independent of
    /// `store.activeEnvContext` (which controls what gets *injected*).
    /// `nil` = "default" tab (the base, always-applied vars).
    @State private var viewedTab: String? = nil
    @State private var revealAll: Bool = false

    /// Total of base + every overlay var. Communicates "how much env stuff
    /// lives on this service" at-a-glance; the picker in trailing carries
    /// the active-context info.
    private var totalCount: Int {
        env.base.count + env.contexts.reduce(0) { $0 + $1.vars.count }
    }

    var body: some View {
        CollapsibleSection(
            id: "service.\(serviceID).env",
            title: "Environment",
            count: totalCount,
            trailing: { EnvContextPicker(scope: env) }
        ) {
            VStack(alignment: .leading, spacing: 8) {
                tabs
                Divider()
                varsList
            }
            .padding(10)
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.black.opacity(0.05))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.10))
            }
        }
    }

    @ViewBuilder
    private var tabs: some View {
        HStack(spacing: 4) {
            tabButton(label: "default", value: nil)
            ForEach(env.contextNames, id: \.self) { name in
                tabButton(label: name, value: name)
            }
            Spacer(minLength: 0)
            revealToggle
        }
    }

    @ViewBuilder
    private var revealToggle: some View {
        Button {
            revealAll.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: revealAll ? "eye.slash" : "eye")
                    .font(.system(size: 10))
                Text(revealAll ? "Hide all" : "Show all")
                    .font(.caption)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(Color.primary.opacity(0.04))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.10))
            }
        }
        .buttonStyle(.plain)
        .help(revealAll ? "Hide all values" : "Reveal all values")
    }

    @ViewBuilder
    private func tabButton(label: String, value: String?) -> some View {
        let isViewed = (viewedTab == value)
        let isActive = (store.activeEnvContext == value)
        Button {
            viewedTab = value
        } label: {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption.weight(isViewed ? .semibold : .regular))
                if isActive {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 5, height: 5)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(isViewed ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.04))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(
                        isViewed ? Color.accentColor.opacity(0.40) : Color.primary.opacity(0.10)
                    )
            }
            .foregroundStyle(isViewed ? Color.accentColor : .secondary)
        }
        .buttonStyle(.plain)
        .help(isActive ? "\(label) — active" : label)
    }

    @ViewBuilder
    private var varsList: some View {
        let entries: [EnvVar] = (viewedTab == nil) ? env.base : env.vars(in: viewedTab!)
        if entries.isEmpty {
            Text("No overrides for this context")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(entries, id: \.name) { v in
                        envRow(v)
                    }
                }
            }
            .frame(maxHeight: 240)
        }
    }

    @ViewBuilder
    private func envRow(_ v: EnvVar) -> some View {
        let displayValue: String = revealAll
            ? v.value
            : String(repeating: "•", count: min(max(v.value.count, 4), 12))

        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(v.name)
                .font(.system(.caption, design: .monospaced).weight(.medium))
                .foregroundStyle(.secondary)
                .frame(minWidth: 140, alignment: .leading)
                .textSelection(.enabled)
            Text(displayValue)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
    }
}
