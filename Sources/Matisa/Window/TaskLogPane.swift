import SwiftUI

/// Pane displaying live (or last) output from a build / script task.
///
/// Lifecycle (mirrors the slot state in `TaskRunner`):
///   running   → clear + stop, no close
///   exited    → clear + close
/// The pane is only mounted when the slot is non-idle; closing it discards
/// the buffer and returns the slot to idle.
struct TaskLogPane: View {
    let title: String
    let subtitle: String?
    let buffer: String
    let isRunning: Bool
    let onStop: () -> Void
    let onClear: () -> Void
    let onClose: () -> Void

    @State private var autoScroll: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Toggle("Auto-scroll", isOn: $autoScroll)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .font(.caption)
                IconButton("trash", help: "Clear", onTap: onClear)
                if isRunning {
                    IconButton("stop.fill", help: "Stop", tint: .red, onTap: onStop)
                } else {
                    IconButton("xmark", help: "Close pane", onTap: onClose)
                }
            }

            ScrollViewReader { proxy in
                ScrollView {
                    Text(buffer.isEmpty ? AttributedString("No output yet.") : ANSI.attributedString(from: buffer))
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(10)
                        .id("taskTail")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.black.opacity(0.05))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.10))
                }
                .onChange(of: buffer) { _, _ in
                    if autoScroll {
                        proxy.scrollTo("taskTail", anchor: .bottom)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
