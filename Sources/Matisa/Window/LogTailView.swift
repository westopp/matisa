import SwiftUI
import Foundation

struct LogTailView: View {
    let logURL: URL?
    @State private var content: String = ""
    @State private var pollTask: Task<Void, Never>?
    @State private var autoScroll: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Logs")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                Spacer()
                if let logURL {
                    Text(logURL.lastPathComponent)
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                }
                Toggle("Auto-scroll", isOn: $autoScroll)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .font(.caption)
                IconButton("trash", help: "Clear logs") { clearLogs() }
            }

            ScrollViewReader { proxy in
                ScrollView {
                    Text(content.isEmpty ? "No logs yet." : content)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(10)
                        .id("logTail")
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
                .onChange(of: content) { _, _ in
                    if autoScroll {
                        proxy.scrollTo("logTail", anchor: .bottom)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { startPolling() }
        .onDisappear { stopPolling() }
        .onChange(of: logURL) { _, _ in
            content = ""
            startPolling()
        }
    }

    private func startPolling() {
        stopPolling()
        guard let url = logURL else { return }
        pollTask = Task {
            while !Task.isCancelled {
                let latest = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
                let tail = String(latest.suffix(20_000))
                await MainActor.run {
                    if tail != self.content { self.content = tail }
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func clearLogs() {
        if let url = logURL {
            try? Data().write(to: url, options: .atomic)
        }
        content = ""
    }
}
