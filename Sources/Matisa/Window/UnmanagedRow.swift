import SwiftUI
import MatisaCore

/// Minimal row for the Unmanaged section. Non-selectable — only the stop
/// button is interactive. Unmanaged things have no detail view.
struct UnmanagedRow: View {
    let service: Service
    let onStart: () -> Void
    let onStop: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconName)
                .font(.system(size: 13))
                .foregroundStyle(dotColor)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 3) {
                Text(displayName)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Circle()
                        .fill(dotColor)
                        .frame(width: 7, height: 7)
                    if let port = port {
                        Text(verbatim: ":\(port)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    Text(verbatim: subtitle)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }

            Spacer(minLength: 4)

            if isStopped {
                IconButton("play.fill", help: "Start", tint: .green, onTap: onStart)
            } else {
                IconButton("stop.fill", help: "Stop", tint: .red, onTap: onStop)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.primary.opacity(0.04))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.12))
        }
    }

    private var isStopped: Bool {
        if case .stopped = service.state { return true }
        return false
    }

    private var dotColor: Color {
        isStopped ? .secondary : .orange
    }

    private var fields: UnmanagedFields? {
        if case .unmanaged(let f) = service.spec { return f }
        return nil
    }
    private var iconName: String { fields?.iconName ?? "questionmark.circle" }
    private var displayName: String { fields?.displayName ?? service.name }
    private var subtitle: String { fields?.subtitle ?? "" }
    private var port: Int? { fields?.port }
}
