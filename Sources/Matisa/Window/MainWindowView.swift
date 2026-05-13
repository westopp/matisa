import SwiftUI
import MatisaCore
import AppKit

enum SidebarSelection: Hashable {
    case service(String)
    case caddy
    case docker
    case configError
}

struct MainWindowView: View {
    @Environment(ServiceStore.self) private var store
    @State private var selection: SidebarSelection? = nil

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 320, ideal: 360, max: 480)
        } detail: {
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.regularMaterial)
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await store.refresh() }
                } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh")
                    .disabled(store.isRefreshing)
            }
        }
        .alert(
            "Docker isn't running",
            isPresented: dockerPromptBinding,
            presenting: store.pendingDockerPrompt
        ) { prompt in
            Button("Start Docker") {
                Task { await store.confirmDockerStart() }
            }
            Button("Cancel", role: .cancel) {
                store.cancelDockerStart()
            }
        } message: { prompt in
            Text("Start Docker Desktop and continue with \(actionLabel(prompt.action)) on \(prompt.serviceName)?")
        }
        .sheet(isPresented: dockerStartingBinding) {
            DockerStartingSheet()
                .environment(store)
        }
        .onAppear { autoSelect() }
        .onChange(of: store.services.map(\.id)) { _, _ in autoSelect() }
    }

    private var dockerPromptBinding: Binding<Bool> {
        Binding(
            get: { store.pendingDockerPrompt != nil },
            set: { if !$0 { store.cancelDockerStart() } }
        )
    }

    private var dockerStartingBinding: Binding<Bool> {
        Binding(
            get: { store.dockerSystem.isStarting },
            // Esc / click-outside / programmatic dismiss → treat as Cancel.
            // The sheet is also dismissed naturally when the state transitions
            // out of `.starting`, in which case `cancelDockerStartInFlight` is
            // a no-op (it guards on `.isStarting`).
            set: { presented in
                if !presented { store.cancelDockerStartInFlight() }
            }
        )
    }

    private func actionLabel(_ action: ServiceAction) -> String {
        switch action {
        case .start: "starting"
        case .stop: "stopping"
        case .restart: "restarting"
        case .pull: "pulling"
        case .takeOver: "taking over"
        case .kill: "killing"
        default: "this action"
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        @Bindable var bindable = store
        return VStack(spacing: 0) {
            sidebarHeader
                .padding(.horizontal, 12)
                .padding(.top, 12)
                .padding(.bottom, 14)

            searchField(text: $bindable.search)
                .padding(.horizontal, 12)
                .padding(.top, 0)
                .padding(.bottom, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if store.configError != nil {
                        configErrorRow
                    }

                    CollapsibleSection(
                        id: "projects",
                        title: "Projects",
                        count: filteredProjects.count,
                        collapsedAccessory: {
                            GroupRunningIndicator(runningCount: runningCount(filteredProjects))
                        }
                    ) {
                        groupedRows(filteredProjects, category: "projects")
                    }

                    if !filteredDocker.isEmpty {
                        CollapsibleSection(
                            id: "docker",
                            title: "Docker",
                            count: filteredDocker.count,
                            collapsedAccessory: {
                                GroupRunningIndicator(runningCount: runningCount(filteredDocker))
                            }
                        ) {
                            groupedRows(filteredDocker, category: "docker")
                        }
                    }

                    if !filteredCompose.isEmpty {
                        CollapsibleSection(
                            id: "compose",
                            title: "Compose Stacks",
                            count: filteredCompose.count,
                            collapsedAccessory: {
                                GroupRunningIndicator(runningCount: runningCount(filteredCompose))
                            }
                        ) {
                            groupedRows(filteredCompose, category: "compose")
                        }
                    }

                    CollapsibleSection(
                        id: "system",
                        title: "System",
                        count: 2,
                        collapsedAccessory: {
                            GroupRunningIndicator(runningCount: systemRunningCount)
                        }
                    ) {
                        VStack(spacing: 6) {
                            caddyRow
                            dockerRow
                        }
                    }

                    CollapsibleSection(
                        id: "unmanaged",
                        title: "Unmanaged",
                        count: filteredUnmanaged.count,
                        collapsedAccessory: {
                            GroupRunningIndicator(runningCount: unmanagedActiveCount(filteredUnmanaged))
                        }
                    ) {
                        if filteredUnmanaged.isEmpty {
                            Text(store.unmanaged.isEmpty
                                ? "Nothing running outside Matisa."
                                : "No matches for \"\(store.search)\".")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                        } else {
                            VStack(alignment: .leading, spacing: 10) {
                                if !filteredUnmanagedProcesses.isEmpty {
                                    CollapsibleSection(
                                        id: "unmanaged.projects",
                                        title: "Projects",
                                        count: filteredUnmanagedProcesses.count,
                                        collapsedAccessory: {
                                            GroupRunningIndicator(runningCount: unmanagedActiveCount(filteredUnmanagedProcesses))
                                        }
                                    ) {
                                        unmanagedRows(filteredUnmanagedProcesses)
                                    }
                                }
                                if !filteredUnmanagedContainers.isEmpty {
                                    CollapsibleSection(
                                        id: "unmanaged.docker",
                                        title: "Docker Containers",
                                        count: filteredUnmanagedContainers.count,
                                        collapsedAccessory: {
                                            GroupRunningIndicator(runningCount: runningCount(filteredUnmanagedContainers))
                                        }
                                    ) {
                                        unmanagedRows(filteredUnmanagedContainers)
                                    }
                                }
                            }
                            .padding(.leading, 12)
                        }
                    }

                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
            }
        }
        .background(.regularMaterial)
        .frame(minWidth: 320)
    }

    @ViewBuilder
    private var sidebarHeader: some View {
        HStack(spacing: 6) {
            Menu {
                Button {
                    copyConfigPath()
                } label: {
                    Label("Copy Folder Path", systemImage: "doc.on.doc")
                }
                Button {
                    openConfigInFinder()
                } label: {
                    Label("Show in Finder", systemImage: "folder")
                }
            } label: {
                circleIcon("folder.fill")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Config folder")

            Menu {
                Button {
                    var state = UIStatePersistence.load()
                    state.collapseByDefault = true
                    UIStatePersistence.save(state)
                    NotificationCenter.default.post(name: .collapsibleSectionsCollapseAll, object: nil)
                } label: {
                    Label("Collapse All", systemImage: "rectangle.compress.vertical")
                }
                Button {
                    var state = UIStatePersistence.load()
                    state.collapsedSections.removeAll()
                    state.collapseByDefault = false
                    UIStatePersistence.save(state)
                    NotificationCenter.default.post(name: .collapsibleSectionsExpandAll, object: nil)
                } label: {
                    Label("Expand All", systemImage: "rectangle.expand.vertical")
                }
            } label: {
                circleIcon("chevron.up.chevron.down")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Sections")

            Spacer()
        }
    }

    private func circleIcon(_ systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)
            .frame(width: 24, height: 24)
            .background {
                Circle().fill(Color.primary.opacity(0.08))
            }
            .overlay {
                Circle().strokeBorder(Color.primary.opacity(0.10))
            }
    }

    private func copyConfigPath() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(Paths.configDir.path, forType: .string)
    }

    private func openConfigInFinder() {
        NSWorkspace.shared.open(Paths.configDir)
    }

    @ViewBuilder
    private func searchField(text: Binding<String>) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            TextField("Search services", text: text)
                .textFieldStyle(.plain)
                .font(.callout)
            if !text.wrappedValue.isEmpty {
                Button {
                    text.wrappedValue = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Clear")
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color.primary.opacity(0.06))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10))
        }
    }

    @ViewBuilder
    private var configErrorRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("Config error")
                    .font(.callout.weight(.semibold))
                Text("Click to view")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.red.opacity(0.10))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(Color.red.opacity(0.35))
        }
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .onTapGesture { selection = .configError }
    }

    @ViewBuilder
    private func rows(_ services: [Service]) -> some View {
        VStack(spacing: 6) {
            ForEach(services) { svc in
                ServiceRow(
                    service: svc,
                    isSelected: selection == .service(svc.id),
                    onPrimary: { Task { await primary(svc) } },
                    onAction: { action in Task { await store.perform(action, on: svc) } }
                )
                // contentShape lives inside ServiceRow; the row itself
                // becomes selectable via a tap gesture so nested IconButtons
                // can still claim their own clicks (no nested-Button problem).
                .onTapGesture { selection = .service(svc.id) }
            }
        }
    }

    @ViewBuilder
    private var caddyRow: some View {
        HStack(spacing: 10) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Caddy")
                        .font(.body.weight(.medium))
                    HStack(spacing: 6) {
                        Circle()
                            .fill(store.caddyService.running ? Color.green : Color.secondary)
                            .frame(width: 7, height: 7)
                        Text(store.caddyService.running ? "Running" : "Stopped")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                IconButton(
                    store.caddyService.running ? "stop.fill" : "play.fill",
                    help: store.caddyService.running ? "Stop" : "Start",
                    tint: store.caddyService.running ? .red : .green
                ) {
                    Task {
                        await store.performCaddy(store.caddyService.running ? .stop : .start)
                    }
                }
            }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(selection == .caddy ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.04))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(
                    selection == .caddy ? Color.accentColor.opacity(0.55) : Color.primary.opacity(0.12)
                )
        }
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .onTapGesture { selection = .caddy }
    }

    @ViewBuilder
    private var dockerRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text("Docker")
                    .font(.body.weight(.medium))
                HStack(spacing: 6) {
                    Circle()
                        .fill(dockerIndicatorColor)
                        .frame(width: 7, height: 7)
                    Text(dockerStatusLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            dockerRowTrailing
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(selection == .docker ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.04))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(
                    selection == .docker ? Color.accentColor.opacity(0.55) : Color.primary.opacity(0.12)
                )
        }
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .onTapGesture { selection = .docker }
    }

    @ViewBuilder
    private var dockerRowTrailing: some View {
        switch store.dockerSystem {
        case .starting:
            ProgressView().controlSize(.small)
        case .running:
            IconButton("stop.fill", help: "Quit Docker Desktop", tint: .red) {
                Task { await store.performDockerStop() }
            }
        case .startFailed:
            HStack(spacing: 4) {
                IconButton("xmark", help: "Dismiss", tint: .secondary) {
                    store.clearDockerStartFailure()
                }
                IconButton("arrow.clockwise", help: "Retry start", tint: .green) {
                    store.clearDockerStartFailure()
                    Task { await store.performDockerStart() }
                }
            }
        case .stopped, .unknown:
            IconButton("play.fill", help: "Start Docker Desktop", tint: .green) {
                Task { await store.performDockerStart() }
            }
        }
    }

    private var dockerIndicatorColor: Color {
        switch store.dockerSystem {
        case .running: .green
        case .starting: .yellow
        case .startFailed: .orange
        case .stopped, .unknown: .secondary
        }
    }

    private var dockerStatusLabel: String {
        switch store.dockerSystem {
        case .running: "Running"
        case .stopped: "Stopped"
        case .starting: "Starting…"
        case .startFailed: "Failed to start"
        case .unknown: "Checking…"
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var detail: some View {
        switch selection {
        case .service(let id):
            if let svc = store.service(id: id) {
                ServiceDetailView(service: svc).id(svc.id)
            } else {
                emptyDetail
            }
        case .caddy:
            CaddyDetailView()
        case .docker:
            DockerDetailView()
        case .configError:
            ConfigErrorView()
        case .none:
            emptyDetail
        }
    }

    private var emptyDetail: some View {
        ContentUnavailableView(
            "Select a service",
            systemImage: "rectangle.stack",
            description: Text("Pick something from the sidebar to see details and actions.")
        )
    }

    // MARK: - Filtering

    private var query: String { store.search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    private func matches(_ svc: Service) -> Bool {
        guard !query.isEmpty else { return true }
        if svc.name.lowercased().contains(query) { return true }
        if let url = svc.spec.primaryURL, url.lowercased().contains(query) { return true }
        if let port = svc.spec.exposedPorts.first?.port, "\(port)".contains(query) { return true }
        return false
    }

    private var filteredProjects: [Service] { store.services.filter { $0.kind == .project && matches($0) } }
    private var filteredDocker:   [Service] { store.services.filter { $0.kind == .docker && matches($0) } }
    private var filteredCompose:  [Service] { store.services.filter { $0.kind == .compose && matches($0) } }
    private var filteredUnmanaged: [Service] { store.unmanaged.filter { matches($0) } }
    private var filteredUnmanagedContainers: [Service] {
        filteredUnmanaged.filter {
            if case .unmanaged(let f) = $0.spec, case .container = f.kind { return true }
            return false
        }
    }
    private var filteredUnmanagedProcesses: [Service] {
        filteredUnmanaged.filter {
            if case .unmanaged(let f) = $0.spec, case .process = f.kind { return true }
            return false
        }
    }

    /// Count of services in `state.isRunning` — what the indicator shows for
    /// managed sections (projects, docker, compose, unmanaged containers).
    private func runningCount(_ services: [Service]) -> Int {
        services.filter { $0.state.isRunning }.count
    }

    /// For the unmanaged section: a `.unmanaged(pid:)` state means the
    /// service is currently active (it's listed precisely because lsof
    /// caught it listening). Treat both `.running` and `.unmanaged` as
    /// active so unmanaged processes count toward the indicator.
    private func unmanagedActiveCount(_ services: [Service]) -> Int {
        services.filter {
            switch $0.state {
            case .running, .unmanaged: return true
            default: return false
            }
        }.count
    }

    /// System section has two rows (Caddy, Docker). Lit when each is up.
    private var systemRunningCount: Int {
        (store.caddyService.running ? 1 : 0) + (store.dockerSystem.isRunning ? 1 : 0)
    }

    /// Lays out a category's services with optional sub-groups. Ungrouped
    /// services render at the category root; groups appear below as nested
    /// CollapsibleSections. Single-member groups flatten to avoid one-row
    /// indents.
    @ViewBuilder
    private func groupedRows(_ services: [Service], category: String) -> some View {
        let partition = ServiceGrouping.partition(services)
        VStack(alignment: .leading, spacing: 10) {
            if !partition.ungrouped.isEmpty {
                rows(partition.ungrouped)
            }
            ForEach(partition.groups, id: \.key) { group in
                if group.services.count == 1 {
                    rows(group.services)
                } else {
                    let allRunning = group.services.allSatisfy { $0.state.isRunning }
                    let anyRunning = group.services.contains { $0.state.isRunning }
                    let runningCount = group.services.filter { $0.state.isRunning }.count
                    CollapsibleSection(
                        id: "\(category).group.\(group.key)",
                        title: group.displayName,
                        count: group.services.count,
                        trailing: {
                            HStack(spacing: 2) {
                                IconButton(
                                    "play.fill",
                                    help: "Start all in \(group.displayName)",
                                    disabled: allRunning
                                ) {
                                    for svc in group.services where !svc.state.isRunning {
                                        Task { await store.perform(.start, on: svc) }
                                    }
                                }
                                IconButton(
                                    "stop.fill",
                                    help: "Stop all in \(group.displayName)",
                                    disabled: !anyRunning
                                ) {
                                    for svc in group.services where svc.state.isRunning {
                                        Task { await store.perform(.stop, on: svc) }
                                    }
                                }
                            }
                        },
                        collapsedAccessory: {
                            GroupRunningIndicator(runningCount: runningCount)
                        }
                    ) {
                        rows(group.services)
                    }
                    .padding(.leading, 12)
                }
            }
        }
    }

    @ViewBuilder
    private func unmanagedRows(_ services: [Service]) -> some View {
        TruncatedUnmanagedList(
            services: services,
            onStart: { svc in Task { await store.perform(.start, on: svc) } },
            onStop:  { svc in Task { await store.perform(.stop,  on: svc) } }
        )
    }

    // MARK: - Helpers

    private func autoSelect() {
        if selection == nil, let first = store.services.first {
            selection = .service(first.id)
        }
    }

    private func primary(_ service: Service) async {
        switch service.state {
        case .stopped, .error: await store.perform(.start, on: service)
        case .running:         await store.perform(.stop, on: service)
        case .unmanaged:
            if case .project = service.spec {
                await store.perform(.takeOver, on: service)
            } else {
                await store.perform(.stop, on: service)
            }
        case .starting, .stopping: break
        }
    }
}

/// Lays out an unmanaged subsection: running rows first, then a capped tail
/// of stopped rows with a show more/less toggle. Cap is 4 when nothing is
/// running, 3 when something is — matches the "always surface running first"
/// rule.
private struct TruncatedUnmanagedList: View {
    let services: [Service]
    let onStart: (Service) -> Void
    let onStop: (Service) -> Void

    @State private var expanded: Bool = false

    var body: some View {
        let running = services.filter { !isStopped($0) }
        let stopped = services.filter(isStopped)
        let cap = running.isEmpty ? 4 : 3
        let visibleStopped = expanded ? stopped : Array(stopped.prefix(cap))
        let hidden = stopped.count - visibleStopped.count

        VStack(spacing: 6) {
            ForEach(running) { svc in row(svc) }
            ForEach(visibleStopped) { svc in row(svc) }
            if stopped.count > cap {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
                } label: {
                    Text(expanded ? "Show less" : "Show \(hidden) more")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private func row(_ svc: Service) -> some View {
        UnmanagedRow(
            service: svc,
            onStart: { onStart(svc) },
            onStop:  { onStop(svc) }
        )
    }

    private func isStopped(_ svc: Service) -> Bool {
        if case .stopped = svc.state { return true }
        return false
    }
}
