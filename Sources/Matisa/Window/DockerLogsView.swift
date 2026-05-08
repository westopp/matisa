import SwiftUI
import Foundation

/// Tails `docker logs -f <container>` (or `docker compose logs -f`) into a
/// scrolling log view. Uses Process directly (not Shell.runCapturing) so we
/// can stream rather than wait for completion.
///
/// For compose stacks: enumerates the stack's services up front so the user
/// can switch between an aggregated "All" feed and a per-service slice. The
/// underlying tail is a single `compose logs` process; filtering is done
/// client-side on the buffered content.
struct DockerLogsView: View {
    let service: Service
    @State private var content: String = ""
    @State private var task: Task<Void, Never>?
    @State private var process: Process?
    @State private var autoScroll: Bool = true

    /// Compose-only: list of service names in this stack. Empty for non-compose.
    @State private var composeServices: [String] = []
    /// Compose-only: nil = "All". Otherwise the selected service name.
    @State private var serviceFilter: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Logs")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                if isCompose && !composeServices.isEmpty {
                    serviceFilterPicker
                }
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
                    Text(displayedAttributedString)
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
                .onChange(of: serviceFilter) { _, _ in
                    if autoScroll {
                        proxy.scrollTo("dockerTail", anchor: .bottom)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            start()
            loadComposeServicesIfNeeded()
        }
        .onDisappear { stop() }
        .onChange(of: service.id) { _, _ in
            stop()
            content = ""
            composeServices = []
            serviceFilter = nil
            start()
            loadComposeServicesIfNeeded()
        }
    }

    // MARK: - Filter UI

    private var isCompose: Bool {
        if case .compose = service.spec { return true }
        return false
    }

    @ViewBuilder
    private var serviceFilterPicker: some View {
        Menu {
            Button {
                serviceFilter = nil
            } label: {
                Label("All", systemImage: serviceFilter == nil ? "checkmark" : "")
            }
            Divider()
            ForEach(composeServices, id: \.self) { name in
                Button {
                    serviceFilter = name
                } label: {
                    Label(name, systemImage: serviceFilter == name ? "checkmark" : "")
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "line.3.horizontal.decrease")
                    .font(.system(size: 9, weight: .semibold))
                Text(serviceFilter ?? "All")
                    .font(.system(.caption, design: .monospaced))
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .opacity(0.55)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background {
                Capsule().fill(Color.primary.opacity(0.06))
            }
            .overlay {
                Capsule().strokeBorder(Color.primary.opacity(0.15))
            }
            .foregroundStyle(.secondary)
            .contentShape(Capsule())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Filter logs by service")
    }

    /// Renders either the full buffer (`All`) or a per-service slice with the
    /// `service-N  | ` prefix stripped from each line.
    private var displayedAttributedString: AttributedString {
        if content.isEmpty {
            return AttributedString("Waiting for logs…")
        }
        guard let target = serviceFilter else {
            return ANSI.attributedString(from: content)
        }
        let stripped = stripPrefix(content, forService: target)
        if stripped.isEmpty {
            return AttributedString("No lines from \(target) yet…")
        }
        return ANSI.attributedString(from: stripped)
    }

    /// Filters `raw` to lines from `target`, stripping the compose prefix.
    /// Compose's prefix format is `<service>-<n>  | <body>`; we match the
    /// service name up to the dash, then take what's after the first `|`.
    private func stripPrefix(_ raw: String, forService target: String) -> String {
        var output = ""
        for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = String(line)
            guard s.hasPrefix("\(target)-") else { continue }
            guard let pipeIdx = s.firstIndex(of: "|") else { continue }
            let after = s.index(after: pipeIdx)
            let body: String
            if after < s.endIndex && s[after] == " " {
                body = String(s[s.index(after: after)...])
            } else if after < s.endIndex {
                body = String(s[after...])
            } else {
                body = ""
            }
            output += body + "\n"
        }
        return output
    }

    // MARK: - Tail process

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

        // Detached: `availableData` is a synchronous blocking read. Inheriting
        // the surrounding @MainActor isolation would freeze the UI while the
        // child process spins up — visible as a beachball when first selecting
        // a compose stack, since `docker compose logs -f` enumerates every
        // service before it streams.
        task = Task.detached { [pipe] in
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

    /// Compose-only: populate the picker with `docker compose config --services`.
    /// Best-effort — failures leave the picker hidden (single-stream view only).
    private func loadComposeServicesIfNeeded() {
        guard case .compose(let f) = service.spec else { return }
        Task {
            do {
                let output = try await Shell.runCapturing(
                    executable: DockerProbe.dockerPath,
                    arguments: ["compose", "-f", f.file.path, "config", "--services"]
                )
                let names = output
                    .split(separator: "\n")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
                composeServices = names
            } catch {
                composeServices = []
            }
        }
    }
}
