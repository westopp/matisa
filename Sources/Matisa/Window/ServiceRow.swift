import SwiftUI

struct ServiceRow: View {
    let service: Service
    let isSelected: Bool
    let onPrimary: () -> Void
    let onAction: (ServiceAction) -> Void

    var body: some View {
        HStack(spacing: 10) {
            kindIcon
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 3) {
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
                }
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
    private var metaLine: some View {
        HStack(spacing: 8) {
            StateBadge(state: service.state, compact: true)
                .layoutPriority(1)
            if let port = service.spec.exposedPorts.first?.port {
                Text(verbatim: ":\(port)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            if let env = service.spec.env, !env.isEmpty {
                EnvContextPicker(scope: env)
            }
        }
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
