import SwiftUI
import MatisaCore

struct EngineDetailView: View {
    @Environment(ServiceStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            hero
            actionRow
            metadataLine
            Divider()
            CLIInstallSection()
            Divider()
            descriptionPanel
            Spacer()
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var hero: some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
                    .frame(width: 42, height: 42)
                Image(systemName: "gearshape.2.fill")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(store.engineStatus != nil ? .green : .secondary)
                        .frame(width: 9, height: 9)
                    Text("Matisa Engine")
                        .font(.title2.weight(.semibold))
                }
                Text(store.engineStatus != nil ? "Running" : "Not reachable")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: 6) {
            if store.engineStatus != nil {
                primaryAction("Stop", icon: "stop.fill", tint: .red) {
                    Task { await store.performEngineStop() }
                }
            } else {
                primaryAction("Start", icon: "play.fill", tint: .green) {
                    Task { await store.performEngineStart() }
                }
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func primaryAction(_ label: String, icon: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button {
            action()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: icon)
                Text(label)
            }
            .font(.callout.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(tint.opacity(0.18))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(tint.opacity(0.45))
            }
            .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
    }

    private var metadataLine: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
            GridRow {
                Text("status")
                    .foregroundStyle(.tertiary)
                Text(store.engineStatus?.status ?? "—")
                    .foregroundStyle(.secondary)
            }
            GridRow {
                Text("version")
                    .foregroundStyle(.tertiary)
                Text(store.engineStatus?.version ?? "—")
                    .foregroundStyle(.secondary)
            }
            GridRow {
                Text("uptime")
                    .foregroundStyle(.tertiary)
                Text(uptimeLabel)
                    .foregroundStyle(.secondary)
            }
            GridRow {
                Text("socket")
                    .foregroundStyle(.tertiary)
                Text(EngineClient.defaultSocketPath())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .font(.system(.caption, design: .monospaced))
    }

    private var descriptionPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("About")
                .font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text("The Matisa engine is the background daemon that owns all state and orchestration — Docker, Caddy, services, tunnels, and same-network publishing. Quitting Matisa closes the UI only; the engine keeps running so widgets, the CLI, and MCP can reach it.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var uptimeLabel: String {
        guard let s = store.engineStatus else { return "—" }
        let h = s.uptimeSeconds / 3600
        let m = (s.uptimeSeconds % 3600) / 60
        let sec = s.uptimeSeconds % 60
        if h > 0 { return "\(h)h \(m)m \(sec)s" }
        if m > 0 { return "\(m)m \(sec)s" }
        return "\(sec)s"
    }
}
