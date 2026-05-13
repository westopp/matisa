import SwiftUI
import MatisaCore

struct StateBadge: View {
    let state: ServiceState
    var compact: Bool = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: compact ? 7 : 9, height: compact ? 7 : 9)
                .overlay {
                    Circle()
                        .stroke(color.opacity(0.3), lineWidth: 3)
                        .scaleEffect(animates ? 1.6 : 1)
                        .opacity(animates ? 0 : 0.6)
                        .animation(animates
                            ? .easeOut(duration: 1.2).repeatForever(autoreverses: false)
                            : .default,
                            value: animates)
                }
            if !compact {
                Text(state.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var color: Color {
        switch state {
        case .running: return .green
        case .starting, .stopping: return .yellow
        case .stopped: return .secondary
        case .unmanaged: return .orange
        case .error: return .red
        }
    }

    private var animates: Bool {
        switch state {
        case .starting, .stopping: true
        default: false
        }
    }
}
