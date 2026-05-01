import SwiftUI
import Foundation

/// Tails `docker logs -f <container>` (or `docker compose logs -f`) into a
/// scrolling log view. Uses Process directly (not Shell.runCapturing) so we
/// can stream rather than wait for completion.
struct DockerLogsView: View {
    let service: Service
    @State private var content: String = ""
    @State private var task: Task<Void, Never>?
    @State private var process: Process?
    @State private var autoScroll: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Logs")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(target)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                Toggle("Auto-scroll", isOn: $autoScroll)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .font(.caption)
                IconButton("trash", help: "Clear logs") { content = "" }
            }

            ScrollViewReader { proxy in
                ScrollView {
                    Text(content.isEmpty ? "Waiting for logs…" : content)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(10)
                        .id("dockerTail")
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
                        proxy.scrollTo("dockerTail", anchor: .bottom)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { start() }
        .onDisappear { stop() }
        .onChange(of: service.id) { _, _ in
            stop()
            content = ""
            start()
        }
    }

    private var target: String {
        switch service.spec {
        case .docker(let f):  return DockerProbe.inlineContainerName(f.name)
        case .compose(let f): return f.name
        default: return service.name
        }
    }

    private var arguments: [String] {
        switch service.spec {
        case .docker:
            return ["logs", "-f", "--tail", "200", target]
        case .compose(let f):
            return ["compose", "-f", f.file.path, "logs", "-f", "--tail", "200"]
        default:
            return []
        }
    }

    private func start() {
        let docker = DockerProbe.dockerPath
        let args = arguments
        guard !args.isEmpty else { return }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: docker)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        process = p

        do { try p.run() } catch { return }

        task = Task { [pipe] in
            let handle = pipe.fileHandleForReading
            while !Task.isCancelled {
                let data = handle.availableData
                if data.isEmpty { break }
                if let chunk = String(data: data, encoding: .utf8) {
                    await MainActor.run {
                        content += chunk
                        if content.count > 40_000 {
                            content = String(content.suffix(20_000))
                        }
                    }
                }
            }
        }
    }

    private func stop() {
        task?.cancel()
        task = nil
        process?.terminate()
        process = nil
    }
}
