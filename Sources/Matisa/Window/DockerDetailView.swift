import SwiftUI

/// Shown while we're waiting for Docker Desktop's daemon to come up after
/// firing `open -a Docker`. Modal so the user can't kick off another docker
/// action until the daemon either answers or we time out.
struct DockerStartingSheet: View {
    @Environment(ServiceStore.self) private var store

    var body: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.large)
            Text("Starting Docker Desktop…")
                .font(.title3.weight(.medium))
            Text("Waiting for the daemon to become reachable. This can take 5–15 seconds on first launch.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 320)
            Button("Cancel") {
                store.cancelDockerStartInFlight()
            }
            .keyboardShortcut(.cancelAction)
            .padding(.top, 4)
        }
        .padding(28)
        .frame(minWidth: 380)
    }
}

struct DockerDetailView: View {
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
                Image(systemName: "shippingbox.fill")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(indicatorColor)
                        .frame(width: 9, height: 9)
                    Text("Docker")
                        .font(.title2.weight(.semibold))
                }
                Text(statusLabel)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: 6) {
            switch store.dockerSystem {
            case .running:
                primaryAction("Stop", icon: "stop.fill", tint: .red) {
                    Task { await store.performDockerStop() }
                }
            case .stopped, .startFailed, .unknown:
                primaryAction("Start", icon: "play.fill", tint: .green) {
                    Task { await store.performDockerStart() }
                }
            case .starting:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Starting Docker Desktop…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
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

    @ViewBuilder
    private var metadataLine: some View {
        HStack(spacing: 12) {
            if case let .startFailed(msg) = store.dockerSystem {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(msg)
                        .foregroundStyle(.secondary)
                    Button {
                        store.clearDockerStartFailure()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Dismiss")
                }
            } else {
                Text("Daemon socket: /var/run/docker.sock")
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
            Text("Docker Desktop runs the Linux VM and daemon that your docker and compose services rely on. Matisa starts/stops Docker Desktop here; the same controls fire automatically when you try to launch a docker service while the daemon is down.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var indicatorColor: Color {
        switch store.dockerSystem {
        case .running: .green
        case .starting: .yellow
        case .startFailed: .orange
        case .stopped, .unknown: .secondary
        }
    }

    private var statusLabel: String {
        switch store.dockerSystem {
        case .running: "Running"
        case .stopped: "Stopped"
        case .starting: "Starting…"
        case .startFailed: "Failed to start"
        case .unknown: "Checking…"
        }
    }
}
