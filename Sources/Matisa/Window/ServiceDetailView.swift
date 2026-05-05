import SwiftUI

struct ServiceDetailView: View {
    @Environment(ServiceStore.self) private var store
    let service: Service

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            hero

            if service.isRunningUnmanaged {
                unmanagedBanner
            }

            actionRow

            metadataLine

            if let env = service.spec.env, !env.isEmpty {
                EnvironmentSection(serviceID: service.id, env: env)
            } else {
                Divider()
            }

            logsArea
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - Hero

    private var hero: some View {
        HStack(alignment: .center, spacing: 12) {
            kindBadge
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    StateBadge(state: service.state, compact: true)
                    Text(service.name)
                        .font(.title2.weight(.semibold))
                }
                if let url = service.spec.primaryURL {
                    urlPill(url)
                }
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var kindBadge: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.primary.opacity(0.06))
                .frame(width: 42, height: 42)
            Image(systemName: kindIcon)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(.secondary)
        }
    }

    private var kindIcon: String {
        switch service.kind {
        case .project:   "chevron.left.forwardslash.chevron.right"
        case .docker:    "shippingbox"
        case .compose:   "square.stack.3d.up"
        case .unmanaged: "questionmark.circle"
        }
    }

    @ViewBuilder
    private func urlPill(_ url: String) -> some View {
        HStack(spacing: 6) {
            Button {
                Task { await store.perform(.openURL, on: service) }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "safari")
                        .font(.caption)
                    Text("http://\(url)")
                        .font(.system(.callout, design: .monospaced))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background {
                    Capsule().fill(Color.accentColor.opacity(0.15))
                }
                .overlay {
                    Capsule().strokeBorder(Color.accentColor.opacity(0.35))
                }
                .foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
            .help("Open in browser")

            IconButton("doc.on.doc", help: "Copy URL") {
                Task { await store.perform(.copyURL, on: service) }
            }
        }
    }

    // MARK: - Banner

    private var unmanagedBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Running outside Matisa")
                    .font(.callout.weight(.medium))
                Text("Logs aren't captured. Take over to manage this service.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.orange.opacity(0.10))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.orange.opacity(0.30))
        }
    }

    // MARK: - Actions

    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: 6) {
            // Lifecycle
            switch service.state {
            case .stopped, .error:
                primaryAction("Start", icon: "play.fill", tint: .green) { .start }
            case .running:
                primaryAction("Stop", icon: "stop.fill", tint: .red) { .stop }
                secondaryAction("Restart", icon: "arrow.clockwise") { .restart }
            case .unmanaged:
                if case .project = service.spec {
                    primaryAction("Take over", icon: "arrow.up.forward.app", tint: .orange) { .takeOver }
                }
                secondaryAction("Stop", icon: "stop.fill") { .stop }
            case .starting, .stopping:
                ProgressView().controlSize(.small).padding(.horizontal, 8)
            }

            Divider().frame(height: 16)

            // Navigation icons
            if service.spec.primaryURL != nil {
                IconButton("safari", help: "Open URL") {
                    Task { await store.perform(.openURL, on: service) }
                }
                IconButton("doc.on.doc", help: "Copy URL") {
                    Task { await store.perform(.copyURL, on: service) }
                }
            }
            if case .project = service.spec {
                IconButton("folder", help: "Reveal in Finder") {
                    Task { await store.perform(.revealInFinder, on: service) }
                }
                IconButton("chevron.left.forwardslash.chevron.right", help: "Open in editor") {
                    Task { await store.perform(.revealInEditor, on: service) }
                }
                IconButton("terminal", help: "Open in Terminal") {
                    Task { await store.perform(.revealInTerminal, on: service) }
                }
            }
            if case .compose = service.spec {
                IconButton("folder", help: "Reveal compose file") {
                    Task { await store.perform(.revealInFinder, on: service) }
                }
                IconButton("arrow.down.circle", help: "Pull images") {
                    Task { await store.perform(.pull, on: service) }
                }
            }
            if case .docker = service.spec {
                IconButton("arrow.down.circle", help: "Pull image") {
                    Task { await store.perform(.pull, on: service) }
                }
                IconButton("terminal", help: "Exec shell") {
                    Task { await store.perform(.execShell, on: service) }
                }
            }

            buildControl
            scriptsControl

            if showKillButton {
                IconButton("xmark.octagon", help: "Force kill (SIGKILL)", tint: .red) {
                    Task { await store.perform(.kill, on: service) }
                }
            }

            Spacer()
        }
    }

    // MARK: - Build / scripts controls

    @ViewBuilder
    private var buildControl: some View {
        if let build = service.spec.build {
            let running = store.tasks.slot(service.id, .build).state.isRunning
            if running {
                IconButton("stop.fill", help: "Stop build", tint: .red) {
                    store.tasks.stop(serviceID: service.id, kind: .build)
                }
            } else {
                switch build {
                case .single:
                    IconButton("hammer.fill", help: "Build") {
                        store.runBuild(service)
                    }
                case .multi(let commands):
                    Menu {
                        ForEach(commands, id: \.name) { c in
                            Button(c.name) { store.runBuild(service, named: c.name) }
                        }
                    } label: {
                        Image(systemName: "hammer.fill")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 22, height: 22)
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Build…")
                }
            }
        }
    }

    @ViewBuilder
    private var scriptsControl: some View {
        let scripts = service.spec.scripts
        if !scripts.isEmpty {
            let running = store.tasks.slot(service.id, .script).state.isRunning
            if running {
                IconButton("stop.fill", help: "Stop script", tint: .red) {
                    store.tasks.stop(serviceID: service.id, kind: .script)
                }
            } else {
                Menu {
                    ForEach(scripts, id: \.name) { s in
                        Button(s.name) { store.runScript(service, named: s.name) }
                    }
                } label: {
                    Image(systemName: "terminal.fill")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Run a script…")
            }
        }
    }

    private var showKillButton: Bool {
        switch service.state {
        case .running, .unmanaged: return true
        default: return false
        }
    }

    @ViewBuilder
    private func primaryAction(_ label: String, icon: String, tint: Color, action: () -> ServiceAction) -> some View {
        let act = action()
        Button {
            Task { await store.perform(act, on: service) }
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
    private func secondaryAction(_ label: String, icon: String, action: () -> ServiceAction) -> some View {
        let act = action()
        Button {
            Task { await store.perform(act, on: service) }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: icon)
                Text(label)
            }
            .font(.callout)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.18))
            }
            .foregroundStyle(.primary)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Metadata

    private var metadataLine: some View {
        HStack(spacing: 12) {
            ForEach(metadataItems, id: \.label) { item in
                HStack(spacing: 4) {
                    Text(item.label)
                        .foregroundStyle(.tertiary)
                    Text(item.value)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            Spacer()
        }
        .font(.system(.caption, design: .monospaced))
    }

    private var metadataItems: [(label: String, value: String)] {
        var items: [(String, String)] = []
        switch service.spec {
        case .project(let f):
            items.append(("port", "\(f.port)"))
            if let pid = service.state.pid, pid != 0 {
                items.append(("pid", "\(pid)"))
            }
            items.append(("path", f.path.lastPathComponent))
            items.append(("cmd", f.command))
        case .docker(let f):
            items.append(("port", "\(f.port)"))
            items.append(("image", f.image))
        case .compose(let f):
            items.append(("file", f.file.lastPathComponent))
            items.append(("ports", f.ports.map { "\($0.host)" }.joined(separator: ",")))
        case .unmanaged(let f):
            if let pid = f.pid { items.append(("pid", "\(pid)")) }
            if let port = f.port { items.append(("port", "\(port)")) }
            items.append(("name", f.displayName))
        }
        return items
    }

    // MARK: - Logs

    /// Layout (from the spec):
    ///   - Logs pane is always visible on the left.
    ///   - Build / scripts panes appear in the right column when their slot
    ///     is non-idle. Two open → scripts on top, build on bottom; one open
    ///     → it takes the full right column.
    ///   - +4px on the inter-pane gutter compared to the outer VStack spacing.
    @ViewBuilder
    private var logsArea: some View {
        let buildVisible = store.tasks.isPaneVisible(service.id, .build)
        let scriptVisible = store.tasks.isPaneVisible(service.id, .script)

        HStack(spacing: 18) {
            primaryLogs
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            if buildVisible || scriptVisible {
                VStack(spacing: 18) {
                    if scriptVisible { scriptPane }
                    if buildVisible { buildPane }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder
    private var primaryLogs: some View {
        if service.isRunningUnmanaged {
            VStack(alignment: .leading, spacing: 6) {
                Text("Logs")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                ContentUnavailableView {
                    Label("No logs available", systemImage: "doc.text")
                } description: {
                    Text("This service is running outside Matisa, so its output isn't captured. Take over to start collecting logs.")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else if case .docker = service.spec {
            DockerLogsView(service: service)
        } else if case .compose = service.spec {
            DockerLogsView(service: service)
        } else {
            LogTailView(logURL: service.logsPath)
        }
    }

    @ViewBuilder
    private var buildPane: some View {
        let slot = store.tasks.slot(service.id, .build)
        TaskLogPane(
            title: "Build",
            subtitle: paneSubtitle(slot.state),
            buffer: slot.buffer,
            isRunning: slot.state.isRunning,
            onStop: { store.tasks.stop(serviceID: service.id, kind: .build) },
            onClear: { store.tasks.clear(serviceID: service.id, kind: .build) },
            onClose: { store.tasks.closePane(serviceID: service.id, kind: .build) }
        )
    }

    @ViewBuilder
    private var scriptPane: some View {
        let slot = store.tasks.slot(service.id, .script)
        TaskLogPane(
            title: "Script",
            subtitle: paneSubtitle(slot.state),
            buffer: slot.buffer,
            isRunning: slot.state.isRunning,
            onStop: { store.tasks.stop(serviceID: service.id, kind: .script) },
            onClear: { store.tasks.clear(serviceID: service.id, kind: .script) },
            onClose: { store.tasks.closePane(serviceID: service.id, kind: .script) }
        )
    }

    /// Display the running/exited command name in the pane header.
    private func paneSubtitle(_ state: TaskRunner.TaskState) -> String? {
        switch state {
        case .idle: return nil
        case .running(let name, _): return name
        case .exited(let name, let code, _): return "\(name) · exit \(code)"
        }
    }
}
