import SwiftUI

/// Tiny green-dot readout of the running-service count for a collapsed group.
/// Click to flip every indicator into a 5-bit binary view (global toggle on
/// the store). Renders nothing when there are no running services.
struct GroupRunningIndicator: View {
    let runningCount: Int

    @Environment(ServiceStore.self) private var store

    private let dotSize: CGFloat = 5
    private let dotSpacing: CGFloat = 3
    private let activeColor: Color = .green
    private var inactiveColor: Color { Color.secondary.opacity(0.25) }

    var body: some View {
        if runningCount <= 0 && !store.groupRunIndicatorBinary {
            EmptyView()
        } else {
            Button {
                store.groupRunIndicatorBinary.toggle()
            } label: {
                content
                    .padding(.horizontal, 4)
                    .padding(.vertical, 2)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(store.groupRunIndicatorBinary
                  ? "\(runningCount) running (binary). Click for plain view."
                  : "\(runningCount) running. Click for binary view.")
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.groupRunIndicatorBinary {
            binaryDots
        } else if runningCount <= 3 {
            plainDots
        } else {
            dotPlusCount
        }
    }

    /// 1–3 small green dots, one per running service.
    private var plainDots: some View {
        HStack(spacing: dotSpacing) {
            ForEach(0..<runningCount, id: \.self) { _ in
                Circle()
                    .fill(activeColor)
                    .frame(width: dotSize, height: dotSize)
            }
        }
    }

    /// One green dot and a numeric count for `> 3` running services.
    private var dotPlusCount: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(activeColor)
                .frame(width: dotSize, height: dotSize)
            Text("\(runningCount)")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    /// 5-bit binary readout (MSB on the left). Caps at 31.
    private var binaryDots: some View {
        let capped = min(max(runningCount, 0), 31)
        return HStack(spacing: dotSpacing) {
            ForEach(0..<5, id: \.self) { i in
                let shift = 4 - i
                let on = ((capped >> shift) & 1) == 1
                Circle()
                    .fill(on ? activeColor : inactiveColor)
                    .frame(width: dotSize, height: dotSize)
            }
        }
    }
}
