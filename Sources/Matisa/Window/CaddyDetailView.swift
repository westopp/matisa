import SwiftUI
import MatisaCore

struct CaddyDetailView: View {
    @Environment(ServiceStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            hero
            actionRow
            metadataLine
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
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(store.caddyService.running ? .green : .secondary)
                        .frame(width: 9, height: 9)
                    Text("Caddy")
                        .font(.title2.weight(.semibold))
                }
                Text(store.caddyService.running ? "Running" : "Stopped")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: 6) {
            if store.caddyService.running {
                primaryAction("Stop", icon: "stop.fill", tint: .red) { .stop }
                secondaryAction("Restart", icon: "arrow.clockwise") { .restart }
                secondaryAction("Reload", icon: "arrow.clockwise.circle") { .reload }
            } else {
                primaryAction("Start", icon: "play.fill", tint: .green) { .start }
            }

            Divider().frame(height: 16)

            secondaryAction("Validate", icon: "checkmark.shield") { .validate }
            secondaryAction("Regenerate", icon: "wand.and.rays") { .regenerate }

            Divider().frame(height: 16)

            IconButton("doc.text", help: "Open Caddyfile") {
                Task { await store.performCaddy(.openCaddyfile) }
            }
            IconButton("folder", help: "Reveal in Finder") {
                Task { await store.performCaddy(.revealCaddyfile) }
            }

            Spacer()
        }
    }

    @ViewBuilder
    private func primaryAction(_ label: String, icon: String, tint: Color, action: () -> CaddyAction) -> some View {
        let act = action()
        Button {
            Task { await store.performCaddy(act) }
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

    @ViewBuilder
    private func secondaryAction(_ label: String, icon: String, action: () -> CaddyAction) -> some View {
        let act = action()
        Button {
            Task { await store.performCaddy(act) }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: icon)
                Text(label)
            }
            .font(.callout)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.18))
            }
            .foregroundStyle(.primary)
        }
        .buttonStyle(.plain)
    }

    private var metadataLine: some View {
        HStack(spacing: 12) {
            if let path = store.caddyService.configFile {
                HStack(spacing: 4) {
                    Text("config")
                        .foregroundStyle(.tertiary)
                    Text(path.path)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            } else {
                Text("No Caddyfile path set in config")
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .font(.system(.caption, design: .monospaced))
    }

    private var descriptionPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("About")
                .font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text("""
            Caddy reverse-proxies your `*.localhost` URLs to the local ports declared in services.ts. Use Regenerate to rewrite the Caddyfile from the current config, then Reload to apply it.
            """)
            .font(.callout)
            .foregroundStyle(.primary)
        }
    }
}
