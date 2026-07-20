import SwiftUI
import MatisaCore

struct ServiceRow: View {
    @Environment(ServiceStore.self) private var store
    let service: Service
    let isSelected: Bool
    let onPrimary: () -> Void
    let onAction: (ServiceAction) -> Void

    @State private var showFailurePopover = false

    var body: some View {
        HStack(spacing: 10) {
            kindIcon
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 3) {
                titleLine
                metaLine
            }

            Spacer(minLength: 4)

            inlineActions
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.04))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(
                    isSelected ? Color.accentColor.opacity(0.55) : Color.primary.opacity(0.12),
                    lineWidth: 1
                )
        }
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    @ViewBuilder
    private var kindIcon: some View {
        switch service.kind {
        case .project:   Image(systemName: "chevron.left.forwardslash.chevron.right")
        case .docker:    Image(systemName: "shippingbox")
        case .compose:   Image(systemName: "square.stack.3d.up")
        case .unmanaged: Image(systemName: "questionmark.circle")
        }
    }

    @ViewBuilder
    private var titleLine: some View {
        HStack(spacing: 6) {
            Text(service.name)
                .font(.body.weight(.medium))
                .lineLimit(1)
            if service.isRunningUnmanaged {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .help("Running outside Matisa")
            }
            if let failure = store.launchFailures[service.id] {
                failureIndicator(failure)
            }
        }
    }

    /// Click target for the captured launch failure. Opens a popover with
    /// the full error and a copy-to-clipboard action; the popover is its
    /// own coordinate space so its sizing can't leak into the row layout.
    @ViewBuilder
    private func failureIndicator(_ failure: LaunchFailure) -> some View {
        Button {
            showFailurePopover = true
        } label: {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.red)
        }
        .buttonStyle(.plain)
        .help("Last launch failed — click for details")
        .popover(isPresented: $showFailurePopover, arrowEdge: .leading) {
            LaunchFailurePopover(
                serviceID: service.id,
                failure: failure,
                onClose: { showFailurePopover = false }
            )
            .environment(store)
        }
    }

    @ViewBuilder
    private var metaLine: some View {
        HStack(spacing: 8) {
            StateBadge(state: service.state, compact: true)
                .layoutPriority(1)
            if let port = service.spec.exposedPorts.first?.port {
                HStack(spacing: 3) {
                    Text(verbatim: ":\(port)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                    portCollisionBadge
                }
            }
            if let stats = store.resourceStats[service.id] {
                resourcePill(stats)
            }
            if let env = service.spec.env, !env.isEmpty {
                EnvContextPicker(scope: env)
            }
        }
    }

    /// Amber dot when this service shares a host port with one or more
    /// other configured services. Tooltip names each offending port and the
    /// other service sharing it. The lifecycle button stays clickable —
    /// surfacing the clash is the badge's only job; whether/when to act is
    /// the user's call.
    @ViewBuilder
    private var portCollisionBadge: some View {
        let collisions = store.portCollisionsByServiceID[service.id] ?? []
        if !collisions.isEmpty {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 9))
                .foregroundStyle(.orange)
                .help(portCollisionTooltip(collisions))
        }
    }

    private func portCollisionTooltip(_ collisions: [PortCollision]) -> String {
        let header = collisions.count == 1
            ? "Port collision"
            : "Port collisions (\(collisions.count))"
        let lines = collisions
            .sorted { ($0.port, $0.otherServiceName) < ($1.port, $1.otherServiceName) }
            .map { "• :\($0.port) — also bound by \($0.otherServiceName)" }
        return ([header] + lines).joined(separator: "\n")
    }

    /// Compact CPU% · mem chip. Only shown when the engine has live samples
    /// for this service (i.e. running and the engine resolved a PID). Tooltip
    /// surfaces the underlying process count so a runaway child fanout is
    /// visible on hover without claiming sidebar width for it.
    @ViewBuilder
    private func resourcePill(_ stats: ResourceStats) -> some View {
        HStack(spacing: 4) {
            Text(stats.cpuLabel)
            Text("·").foregroundStyle(.tertiary)
            Text(stats.memLabel)
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .help("\(stats.processCount) process\(stats.processCount == 1 ? "" : "es")")
    }

    @ViewBuilder
    private var inlineActions: some View {
        HStack(spacing: 4) {
            primaryButton

            if service.spec.primaryURL != nil {
                IconButton("safari", help: "Open URL") { onAction(.openURL) }
                IconButton("doc.on.doc", help: "Copy URL") { onAction(.copyURL) }
            }
            if case .project = service.spec {
                IconButton("folder", help: "Reveal in Finder") { onAction(.revealInFinder) }
            }
            exposureIndicators
        }
    }

    /// Tiny, non-interactive icons that surface active public-tunnel /
    /// same-network exposures so the user can see at a glance which services
    /// are reachable off-laptop without opening the detail view.
    @ViewBuilder
    private var exposureIndicators: some View {
        let exposure = store.exposure(for: service)
        if exposure.publicTunnel.isActive {
            Image(systemName: "globe")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color(red: 0.36, green: 0.55, blue: 0.95))
                .frame(width: 18, height: 18)
                .help("Public tunnel active")
        }
        if exposure.sameNetwork.isActive {
            Image(systemName: "wifi")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color(red: 0.20, green: 0.65, blue: 0.65))
                .frame(width: 18, height: 18)
                .help("Exposed on local network")
        }
    }

    @ViewBuilder
    private var primaryButton: some View {
        switch service.state {
        case .stopped, .error:
            IconButton("play.fill", help: "Start", tint: .green, onTap: onPrimary)
        case .running:
            IconButton("stop.fill", help: "Stop", tint: .red, onTap: onPrimary)
        case .starting, .stopping:
            ProgressView().controlSize(.small).frame(width: 22, height: 22)
        case .unmanaged:
            if case .project = service.spec {
                IconButton("arrow.up.forward.app", help: "Take over",
                           tint: .orange, onTap: onPrimary)
            } else {
                IconButton("stop.fill", help: "Stop", tint: .red, onTap: onPrimary)
            }
        }
    }
}

/// Borderless icon button with hover styling and a tooltip. Used everywhere
/// an icon-only action lives.
/// Small circular variant of `IconButton`. Used where the action wants to
/// read as visually separate from an adjacent pill rather than nested in it.
struct CircleIconButton: View {
    let systemImage: String
    let help: String
    var size: CGFloat = 22
    let onTap: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: onTap) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: size, height: size)
                .background {
                    Circle()
                        .fill(hovering ? Color.primary.opacity(0.10) : Color.primary.opacity(0.04))
                }
                .overlay {
                    Circle().strokeBorder(Color.primary.opacity(0.15))
                }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
    }
}

struct IconButton: View {
    let systemImage: String
    let help: String
    var tint: Color? = nil
    var disabled: Bool = false
    let onTap: () -> Void
    @State private var hovering = false

    init(
        _ systemImage: String,
        help: String,
        tint: Color? = nil,
        disabled: Bool = false,
        onTap: @escaping () -> Void
    ) {
        self.systemImage = systemImage
        self.help = help
        self.tint = tint
        self.disabled = disabled
        self.onTap = onTap
    }

    var body: some View {
        Button(action: onTap) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(tint ?? .secondary)
                .frame(width: 22, height: 22)
                .background {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(hovering && !disabled ? Color.primary.opacity(0.10) : Color.clear)
                }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.35 : 1.0)
        .onHover { hovering = $0 }
        .help(help)
    }
}
