import SwiftUI
import MatisaCore
import AppKit

struct ServiceDetailView: View {
    @Environment(ServiceStore.self) private var store
    let service: Service

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            hero

            if service.isRunningUnmanaged {
                unmanagedBanner
            }

            collisionBanner

            actionRow

            metadataLine

            if let links = composeLinks {
                linksSection(links)
            }

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
        HStack(alignment: .top, spacing: 12) {
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
            Spacer(minLength: 12)
            if canShare {
                ExposureControl(service: service)
            }
        }
    }

    /// Share UI is hidden for unmanaged services and for compose stacks
    /// without a primary HTTP target — those are degenerate cases.
    private var canShare: Bool {
        switch service.spec {
        case .project, .docker: return true
        case .compose: return service.spec.exposedPorts.first?.port != nil
        case .unmanaged: return false
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

    // MARK: - Compose links

    /// All `(host, url)` entries declared on a compose stack — only surfaced
    /// when there's more than one, since the hero pill already covers the
    /// single-link case. Returns `nil` for non-compose services and for
    /// compose stacks with ≤ 1 declared URL.
    private var composeLinks: [(host: Int, url: String)]? {
        guard case .compose(let f) = service.spec else { return nil }
        let withURL = f.ports.compactMap { p -> (Int, String)? in
            guard let url = p.url, !url.isEmpty else { return nil }
            return (p.host, url)
        }
        return withURL.count >= 2 ? withURL : nil
    }

    @ViewBuilder
    private func linksSection(_ links: [(host: Int, url: String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Links")
                .font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            // Horizontal flow — pills wrap onto multiple rows as needed
            // instead of stacking vertically. The first entry gets a slightly
            // heavier accent fill in lieu of an explicit "primary" badge.
            FlowLayout(spacing: 6, lineSpacing: 6) {
                ForEach(Array(links.enumerated()), id: \.offset) { idx, link in
                    linkPill(link.host, link.url, isPrimary: idx == 0)
                }
            }
        }
    }

    @ViewBuilder
    private func linkPill(_ port: Int, _ url: String, isPrimary: Bool) -> some View {
        let fillOpacity: Double = isPrimary ? 0.22 : 0.10
        let strokeOpacity: Double = isPrimary ? 0.50 : 0.25
        HStack(spacing: 4) {
            Button {
                if let target = URL(string: "http://\(url)") {
                    NSWorkspace.shared.open(target)
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "safari")
                        .font(.caption2)
                    Text(url)
                        .font(.system(.caption, design: .monospaced))
                    // `verbatim:` so 4-digit port numbers like 5732 don't get
                    // a locale thousands separator inserted ("5 732" in
                    // some Swiss/EU locales).
                    Text(verbatim: ":\(port)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Color.accentColor.opacity(0.65))
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background {
                    Capsule().fill(Color.accentColor.opacity(fillOpacity))
                }
                .overlay {
                    Capsule().strokeBorder(Color.accentColor.opacity(strokeOpacity))
                }
                .foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
            .help("Open in browser")

            CircleIconButton(
                systemImage: "doc.on.doc",
                help: "Copy URL"
            ) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString("http://\(url)", forType: .string)
            }
        }
    }

    // MARK: - Banner

    /// Persistent (not hover-gated) banner listing every port this service
    /// shares with another configured service, plus a one-line action hint.
    /// Renders nothing when no collisions exist — the cheap empty path keeps
    /// the spacing-collapse in `body` clean without an outer `if`.
    @ViewBuilder
    private var collisionBanner: some View {
        let collisions = store.portCollisionsByServiceID[service.id] ?? []
        if !collisions.isEmpty {
            let byPort = Dictionary(grouping: collisions, by: \.port)
            let sortedPorts = byPort.keys.sorted()
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(collisions.count == 1
                         ? "Port collision"
                         : "Port collisions (\(collisions.count))")
                        .font(.callout.weight(.medium))
                    ForEach(sortedPorts, id: \.self) { port in
                        let others = (byPort[port] ?? [])
                            .map(\.otherServiceName)
                            .sorted()
                        HStack(spacing: 6) {
                            Text(":\(port)")
                                .font(.system(.caption, design: .monospaced).weight(.semibold))
                                .foregroundStyle(.primary)
                            Text("also bound by \(others.joined(separator: ", "))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text("Move one of these to a free port (5710–5899) in its dev server config, then update ports.ts.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, 2)
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
    }

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

            commandsControl

            if showKillButton {
                IconButton("xmark.octagon", help: "Force kill (SIGKILL)", tint: .red) {
                    Task { await store.perform(.kill, on: service) }
                }
            }

            Spacer()
        }
    }

    // MARK: - Commands control
    //
    // Single icon, single menu. Each configured command is one menu entry —
    // builds, tests, lints, anything wired up under `commands:`. When a
    // command is running, its menu entry's label flips to `Stop: <name>` and
    // selecting it cancels the running command. When `TaskLimits.maxRunningCommands`
    // are already running, every other (not-yet-running) entry is disabled
    // until something stops. The trigger icon itself never becomes a stop
    // button — stops are reachable via the menu entry or the pane chrome.

    @ViewBuilder
    private var commandsControl: some View {
        let commands = service.spec.commands
        if !commands.isEmpty {
            let atCap = store.tasks.atRunningCap(service.id)
            Menu {
                ForEach(commands, id: \.name) { c in
                    let running = store.tasks.slot(service.id, c.name).state.isRunning
                    if running {
                        Button("Stop: \(c.name)") {
                            store.stopTask(service, name: c.name)
                        }
                    } else {
                        Button(c.name) {
                            store.runCommand(service, named: c.name)
                        }
                        .disabled(atCap)
                    }
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
            .help("Run a command…")
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
        // Live resource utilisation — appended last so the existing metadata
        // ordering doesn't shift when a service starts. Includes process count
        // so a misbehaving service with 50 child workers reads as such
        // without needing the hover tooltip the sidebar uses.
        if let stats = store.resourceStats[service.id] {
            items.append(("cpu", stats.cpuLabel))
            items.append(("mem", stats.memLabel))
            items.append(("procs", "\(stats.processCount)"))
        }
        return items
    }

    // MARK: - Logs

    /// Layout (from the spec):
    ///   - Logs pane is always visible on the left.
    ///   - Command panes appear in the right column whenever a command's
    ///     slot is non-idle (running or exited-but-pane-still-open). Two
    ///     stacked vertically; the running cap of `TaskLimits.maxRunningCommands`
    ///     keeps the visible count practically bounded.
    ///   - +4px on the inter-pane gutter compared to the outer VStack spacing.
    @ViewBuilder
    private var logsArea: some View {
        let visible = store.tasks.visibleSlots(service.id)

        HStack(spacing: 18) {
            primaryLogs
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            if !visible.isEmpty {
                VStack(spacing: 18) {
                    ForEach(visible, id: \.name) { entry in
                        commandPane(name: entry.name, slot: entry.slot)
                    }
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
    private func commandPane(name: String, slot: TaskRunner.TaskSlot) -> some View {
        TaskLogPane(
            title: name,
            subtitle: paneSubtitle(slot.state),
            buffer: slot.buffer,
            isRunning: slot.state.isRunning,
            onStop: { store.stopTask(service, name: name) },
            onClear: { store.clearTask(service, name: name) },
            onClose: { store.closeTaskPane(service, name: name) }
        )
    }

    /// Display the running/exited status in the pane header. The command
    /// name is the pane title, so the subtitle just carries lifecycle
    /// state (since-time would need a relative-formatter; the existing
    /// behaviour just shows exit code on completion).
    private func paneSubtitle(_ state: TaskRunner.TaskState) -> String? {
        switch state {
        case .idle: return nil
        case .running: return "running"
        case .exited(_, let code, _): return "exit \(code)"
        }
    }
}
