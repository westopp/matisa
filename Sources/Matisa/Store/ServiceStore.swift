import Foundation
import Observation
import AppKit

@MainActor
@Observable
final class ServiceStore {
    var services: [Service] = []
    var unmanaged: [Service] = []
    var lastRefresh: Date?
    var isRefreshing: Bool = false
    var configError: ConfigError?
    var caddyService: CaddyServiceInfo = CaddyServiceInfo(running: false, configFile: nil)

    /// Search query — drives filtered views in the UI.
    var search: String = ""

    /// Per-service ad-hoc tasks (build, scripts). Lives on the store so SwiftUI
    /// observation flows through it naturally.
    let tasks = TaskRunner()

    private let configLoader = ConfigLoader()
    private var refreshTask: Task<Void, Never>?
    private var rotateTask: Task<Void, Never>?
    private var pasteboard: NSPasteboard { .general }

    init() {}

    // MARK: - Bootstrap

    func bootstrap() async {
        await refresh()
        startPolling(intervalSeconds: 4)
        startLogRotation()
    }

    func startPolling(intervalSeconds: TimeInterval) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(intervalSeconds * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    func stopPolling() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    private func startLogRotation() {
        rotateTask?.cancel()
        rotateTask = Task.detached(priority: .utility) {
            while !Task.isCancelled {
                LogRotator.rotateAll()
                // Every 10 minutes is plenty.
                try? await Task.sleep(nanoseconds: 10 * 60 * 1_000_000_000)
            }
        }
    }

    // MARK: - Discovery

    func refresh() async {
        if isRefreshing { return }
        isRefreshing = true
        defer { isRefreshing = false; lastRefresh = Date() }

        // Config
        let config: AppConfig
        do {
            config = try await configLoader.load()
            self.configError = nil
        } catch let err as ConfigError {
            self.configError = err
            self.services = []
            self.unmanaged = []
            return
        } catch {
            self.configError = .parseFailed(String(describing: error))
            self.services = []
            self.unmanaged = []
            return
        }

        // Discovery
        let ports = (try? await Lsof.listening()) ?? []
        let containers = await DockerProbe.listContainers()
        let composeStacks = await DockerProbe.listComposeStacks()
        let brew = await BrewServices.list()
        let persisted = StatePersistence.load()

        var built: [Service] = []
        var matchedPIDs: Set<Int32> = []
        var matchedManagedPorts: Set<Int> = []

        for spec in config.services {
            switch spec {
            case .project(let f):
                let listening = ports.first(where: { $0.port == f.port })
                let id = "project:\(f.name)"
                let ourSpawn = persisted.spawns.first(where: { $0.serviceID == id })
                let ourSpawnAlive: PersistedSpawn? = ourSpawn.flatMap {
                    ProcessSupervisor.isAlive(pid: $0.pid) ? $0 : nil
                }

                // If we have a live spawn for this service, it's ours regardless
                // of whether lsof has caught up yet (vite takes a few seconds to
                // bind) and regardless of whether the listening PID matches ours
                // (npm spawns vite as a child, so PIDs differ).
                let state: ServiceState
                if let alive = ourSpawnAlive {
                    if let lp = listening {
                        matchedPIDs.insert(lp.pid)
                        matchedManagedPorts.insert(lp.port)
                    }
                    state = .running(pid: alive.pid, since: alive.startedAt)
                } else if let lp = listening {
                    // Something else is on our port.
                    matchedPIDs.insert(lp.pid)
                    matchedManagedPorts.insert(lp.port)
                    if ourSpawn != nil { StatePersistence.remove(serviceID: id) }
                    state = .unmanaged(pid: lp.pid)
                } else {
                    if ourSpawn != nil { StatePersistence.remove(serviceID: id) }
                    state = .stopped
                }

                built.append(Service(
                    spec: spec,
                    state: state,
                    logsPath: Paths.logFile(for: id)
                ))

            case .docker(let f):
                let cname = DockerProbe.inlineContainerName(f.name)
                let container = containers.first(where: { $0.name == cname })
                let listening = ports.first(where: { $0.port == f.port })
                let state: ServiceState
                if let container, container.isRunning {
                    if let lp = listening { matchedPIDs.insert(lp.pid); matchedManagedPorts.insert(lp.port) }
                    state = .running(pid: 0, since: lastRefresh ?? Date())
                } else if let lp = listening {
                    // Something else is on this port.
                    matchedPIDs.insert(lp.pid)
                    matchedManagedPorts.insert(lp.port)
                    state = .unmanaged(pid: lp.pid)
                } else {
                    state = .stopped
                }
                built.append(Service(
                    spec: spec,
                    state: state,
                    logsPath: Paths.logFile(for: "docker:\(f.name)")
                ))

            case .compose(let f):
                let stack = composeStacks.first(where: { $0.name == f.name })
                let isRunning = stack.map { $0.status.lowercased().contains("running") } ?? false
                if isRunning {
                    for cp in f.ports {
                        if let lp = ports.first(where: { $0.port == cp.host }) {
                            matchedPIDs.insert(lp.pid); matchedManagedPorts.insert(lp.port)
                        }
                    }
                }
                let state: ServiceState = isRunning
                    ? .running(pid: 0, since: lastRefresh ?? Date())
                    : .stopped
                built.append(Service(
                    spec: spec,
                    state: state,
                    logsPath: Paths.logFile(for: "compose:\(f.name)")
                ))

            case .unmanaged:
                continue
            }
        }

        // Caddy info
        let caddy = brew.first(where: { $0.name == "caddy" })
        self.caddyService = CaddyServiceInfo(
            running: caddy?.isRunning ?? false,
            configFile: config.caddyfile
        )

        self.services = built.sorted(by: managedSortKey)

        // Unmanaged processes: dev-y listening ports we haven't matched.
        var unmanagedBuilt: [Service] = []
        var seenPIDs: Set<Int32> = []
        var pidsToResolve: [Int32] = []
        var processCommandByPID: [Int32: (command: String, port: Int)] = [:]
        for lp in ports where !matchedPIDs.contains(lp.pid) && !matchedManagedPorts.contains(lp.port) {
            guard UnmanagedHeuristics.looksLikeDevServer(lp) else { continue }
            if lp.pid <= 1 { continue }
            if seenPIDs.contains(lp.pid) { continue }
            seenPIDs.insert(lp.pid)
            pidsToResolve.append(lp.pid)
            processCommandByPID[lp.pid] = (lp.command, lp.port)
        }

        let appNames = await ProcessIntrospect.resolveAppNames(for: pidsToResolve)
        for pid in pidsToResolve {
            guard let info = processCommandByPID[pid] else { continue }
            unmanagedBuilt.append(Service(
                spec: .unmanaged(UnmanagedFields(
                    kind: .process(
                        pid: pid,
                        command: info.command,
                        port: info.port,
                        appName: appNames[pid]
                    )
                )),
                state: .unmanaged(pid: pid),
                logsPath: nil
            ))
        }

        // Unmanaged containers: every container we don't own, running or
        // stopped, so the user can flip them on/off from one place.
        let knownComposeNames = Set(config.services.compactMap { spec -> String? in
            if case .compose(let f) = spec { return f.name }
            return nil
        })
        for c in containers {
            if c.name.hasPrefix("matisa.") { continue }
            if knownComposeNames.contains(where: {
                c.name.hasPrefix("\($0)-") || c.name.hasPrefix("\($0)_") || c.name == $0
            }) { continue }
            let port = parseFirstHostPort(c.ports)
            let cstate: ServiceState = c.isRunning
                ? .running(pid: 0, since: lastRefresh ?? Date())
                : .stopped
            unmanagedBuilt.append(Service(
                spec: .unmanaged(UnmanagedFields(
                    kind: .container(name: c.name, image: c.image, port: port)
                )),
                state: cstate,
                logsPath: nil
            ))
        }

        self.unmanaged = unmanagedBuilt.sorted { lhs, rhs in
            (lhs.spec.exposedPorts.first?.port ?? 0) < (rhs.spec.exposedPorts.first?.port ?? 0)
        }
    }

    /// Parse the first host port from docker's `Ports` string, e.g.
    /// "0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp" → 5432.
    private func parseFirstHostPort(_ raw: String) -> Int? {
        // Look for "<addr>:<port>->" patterns, return the first <port>.
        for chunk in raw.split(separator: ",") {
            let s = chunk.trimmingCharacters(in: .whitespaces)
            guard let arrow = s.range(of: "->") else { continue }
            let left = s[..<arrow.lowerBound]
            guard let colon = left.lastIndex(of: ":") else { continue }
            let portStr = left[left.index(after: colon)...]
            if let p = Int(portStr) { return p }
        }
        return nil
    }

    private func managedSortKey(_ a: Service, _ b: Service) -> Bool {
        let order: [ServiceKind: Int] = [.project: 0, .docker: 1, .compose: 2, .unmanaged: 99]
        let ak = order[a.kind] ?? 99
        let bk = order[b.kind] ?? 99
        if ak != bk { return ak < bk }
        return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
    }

    // MARK: - Public actions

    func service(id: String) -> Service? {
        services.first(where: { $0.id == id }) ?? unmanaged.first(where: { $0.id == id })
    }

    func perform(_ action: ServiceAction, on service: Service) async {
        switch action {
        case .start:           await start(service)
        case .stop:            await stop(service)
        case .kill:            await kill(service)
        case .restart:         await restart(service)
        case .takeOver:        await takeOver(service)
        case .openURL:         openURL(service)
        case .copyURL:         copyURL(service)
        case .revealInFinder:  revealInFinder(service)
        case .revealInEditor:  revealInEditor(service)
        case .revealInTerminal: revealInTerminal(service)
        case .pull:            await pull(service)
        case .execShell:       execShell(service)
        case .openCaddyfile:   openCaddyfile()
        case .validateCaddy:   await validateCaddy()
        case .reloadCaddy:     await reloadCaddy()
        }
        await refresh()
    }

    private func kill(_ service: Service) async {
        switch service.spec {
        case .project:
            if let pid = service.state.pid, pid > 0 {
                let foreign = service.isRunningUnmanaged
                if foreign { ProcessSupervisor.killForeign(pid: pid) }
                else { ProcessSupervisor.forceKill(pid: pid) }
                StatePersistence.remove(serviceID: service.id)
            }
            markState(service.id, .stopped)
        case .docker(let f):
            _ = try? await Shell.run(
                executable: DockerProbe.dockerPath,
                arguments: ["kill", DockerProbe.inlineContainerName(f.name)]
            )
            markState(service.id, .stopped)
        case .compose(let f):
            _ = try? await DockerProbe.composeDown(file: f.file)
            markState(service.id, .stopped)
        case .unmanaged(let f):
            switch f.kind {
            case let .process(pid, _, _, _):
                ProcessSupervisor.killForeign(pid: pid)
            case let .container(name, _, _):
                _ = try? await Shell.run(
                    executable: DockerProbe.dockerPath,
                    arguments: ["kill", name]
                )
            }
        }
    }

    // MARK: - Build / scripts

    /// Run the configured build for a service. `name` selects which build
    /// command when the spec is `BuildSpec.multi`; ignored for `.single`.
    /// No-op when no build is configured or one is already running.
    func runBuild(_ service: Service, named name: String? = nil) {
        guard let build = service.spec.build else { return }
        let chosen: NamedCommand
        switch build {
        case .single(let cmd):
            chosen = NamedCommand(name: "build", command: cmd)
        case .multi(let commands):
            if let name, let match = commands.first(where: { $0.name == name }) {
                chosen = match
            } else if let first = commands.first {
                chosen = first
            } else {
                return
            }
        }
        tasks.start(
            serviceID: service.id,
            kind: .build,
            name: chosen.name,
            command: chosen.command,
            cwd: service.spec.workingDirectory
        )
    }

    /// Run a named script for a service. No-op if the name isn't configured
    /// or a script is already running for this service.
    func runScript(_ service: Service, named name: String) {
        guard let match = service.spec.scripts.first(where: { $0.name == name }) else { return }
        tasks.start(
            serviceID: service.id,
            kind: .script,
            name: match.name,
            command: match.command,
            cwd: service.spec.workingDirectory
        )
    }

    func performCaddy(_ action: CaddyAction) async {
        switch action {
        case .start:    try? await BrewServices.start("caddy")
        case .stop:     try? await BrewServices.stop("caddy")
        case .restart:  try? await BrewServices.restart("caddy")
        case .reload:   await reloadCaddy()
        case .validate: await validateCaddy()
        case .openCaddyfile: openCaddyfile()
        case .revealCaddyfile: revealCaddyfile()
        case .regenerate: await regenerateCaddyfile()
        }
        await refresh()
    }

    // MARK: - Lifecycle

    private func start(_ service: Service) async {
        switch service.spec {
        case .project(let f):
            // Fail loudly on path typos rather than letting posix_spawn return
            // ENOENT silently and the UI bounce back to .stopped.
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: f.path.path, isDirectory: &isDir)
            if !exists || !isDir.boolValue {
                let msg = "path not found: \(f.path.path)"
                if let data = "[matisa] \(msg)\n".data(using: .utf8) {
                    let log = Paths.logFile(for: service.id)
                    if !FileManager.default.fileExists(atPath: log.path) {
                        FileManager.default.createFile(atPath: log.path, contents: data)
                    } else if let h = try? FileHandle(forWritingTo: log) {
                        h.seekToEndOfFile(); h.write(data); try? h.close()
                    }
                }
                markState(service.id, .error(msg))
                return
            }
            markState(service.id, .starting)
            do {
                let result = try ProcessSupervisor.spawnDetached(
                    shellCommand: f.command,
                    workingDirectory: f.path,
                    serviceID: service.id
                )
                try? await Task.sleep(nanoseconds: 400_000_000)
                StatePersistence.upsert(PersistedSpawn(
                    serviceID: service.id,
                    pid: result.pid,
                    port: f.port,
                    startedAt: Date(),
                    logPath: result.logURL.path
                ))
                markState(service.id, .running(pid: result.pid, since: Date()))
            } catch {
                markState(service.id, .error(String(describing: error)))
            }

        case .docker(let f):
            markState(service.id, .starting)
            do {
                try await DockerProbe.inlineRun(image: f.image, name: f.name, port: f.port)
                markState(service.id, .running(pid: 0, since: Date()))
            } catch {
                markState(service.id, .error(String(describing: error)))
            }

        case .compose(let f):
            markState(service.id, .starting)
            do {
                try await DockerProbe.composeUp(file: f.file)
                markState(service.id, .running(pid: 0, since: Date()))
            } catch {
                markState(service.id, .error(String(describing: error)))
            }

        case .unmanaged(let f):
            if case let .container(name, _, _) = f.kind {
                _ = try? await Shell.run(
                    executable: DockerProbe.dockerPath,
                    arguments: ["start", name]
                )
            }
        }
    }

    private func stop(_ service: Service) async {
        switch service.spec {
        case .project:
            switch service.state {
            case let .running(pid, _):
                markState(service.id, .stopping)
                await ProcessSupervisor.stopWithEscalation(pid: pid)
                StatePersistence.remove(serviceID: service.id)
                markState(service.id, .stopped)
            case let .unmanaged(pid):
                markState(service.id, .stopping)
                await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
                markState(service.id, .stopped)
            default:
                break
            }

        case .docker(let f):
            markState(service.id, .stopping)
            try? await DockerProbe.inlineStop(name: f.name)
            markState(service.id, .stopped)

        case .compose(let f):
            markState(service.id, .stopping)
            try? await DockerProbe.composeDown(file: f.file)
            markState(service.id, .stopped)

        case .unmanaged(let f):
            switch f.kind {
            case let .process(pid, _, _, _):
                await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
            case let .container(name, _, _):
                _ = try? await Shell.run(executable: DockerProbe.dockerPath, arguments: ["stop", name])
            }
        }
    }

    private func restart(_ service: Service) async {
        switch service.spec {
        case .project:
            await stop(service)
            try? await Task.sleep(nanoseconds: 500_000_000)
            if let updated = self.service(id: service.id) {
                await start(updated)
            }
        case .docker(let f):
            try? await DockerProbe.inlineRestart(name: f.name)
        case .compose(let f):
            try? await DockerProbe.composeRestart(file: f.file)
        case .unmanaged:
            break
        }
    }

    /// Take over a managed service that's currently running unmanaged.
    /// Stop the rogue PID, then spawn under our supervisor.
    private func takeOver(_ service: Service) async {
        guard case let .unmanaged(pid) = service.state else { return }
        guard case .project = service.spec else {
            // For docker/compose, the "running unmanaged" case means something
            // else is on the port; we can't take that over, only stop it.
            await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
            return
        }
        markState(service.id, .stopping)
        await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
        try? await Task.sleep(nanoseconds: 400_000_000)
        await start(service)
    }

    private func pull(_ service: Service) async {
        switch service.spec {
        case .docker(let f):
            try? await DockerProbe.inlinePull(image: f.image)
        case .compose(let f):
            try? await DockerProbe.composePull(file: f.file)
        default:
            break
        }
    }

    private func execShell(_ service: Service) {
        let containerTarget: String
        switch service.spec {
        case .docker(let f): containerTarget = DockerProbe.inlineContainerName(f.name)
        case .compose(let f): containerTarget = f.name
        default: return
        }
        let appleScript = #"""
        tell application "Terminal"
            do script "docker exec -it \#(containerTarget) sh"
            activate
        end tell
        """#
        runOsascript(appleScript)
    }

    // MARK: - Reveal helpers

    private func openURL(_ service: Service) {
        guard let host = service.spec.primaryURL,
              let url = URL(string: "http://\(host)") else { return }
        NSWorkspace.shared.open(url)
    }

    private func copyURL(_ service: Service) {
        guard let host = service.spec.primaryURL else { return }
        pasteboard.clearContents()
        pasteboard.setString("http://\(host)", forType: .string)
    }

    private func revealInFinder(_ service: Service) {
        let target: URL?
        switch service.spec {
        case .project(let f): target = f.path
        case .compose(let f): target = f.file.deletingLastPathComponent()
        default: target = nil
        }
        guard let target else { return }
        NSWorkspace.shared.activateFileViewerSelecting([target])
    }

    private func revealInEditor(_ service: Service) {
        guard case .project(let f) = service.spec else { return }
        for editor in ["cursor", "code"] {
            if let bin = Shell.which(editor) {
                Task.detached {
                    try? await Shell.run(executable: bin, arguments: [f.path.path])
                }
                return
            }
        }
        NSWorkspace.shared.open(f.path)
    }

    private func revealInTerminal(_ service: Service) {
        let dir: URL?
        switch service.spec {
        case .project(let f): dir = f.path
        case .compose(let f): dir = f.file.deletingLastPathComponent()
        default: dir = nil
        }
        guard let dir else { return }
        let appleScript = #"""
        tell application "Terminal"
            do script "cd \#(dir.path)"
            activate
        end tell
        """#
        runOsascript(appleScript)
    }

    // MARK: - Caddy

    private func openCaddyfile() {
        guard let path = caddyService.configFile else { return }
        for editor in ["cursor", "code"] {
            if let bin = Shell.which(editor) {
                Task.detached { try? await Shell.run(executable: bin, arguments: [path.path]) }
                return
            }
        }
        NSWorkspace.shared.open(path)
    }

    private func revealCaddyfile() {
        guard let path = caddyService.configFile else { return }
        NSWorkspace.shared.activateFileViewerSelecting([path])
    }

    private func validateCaddy() async {
        guard let path = caddyService.configFile else { return }
        guard let caddyBin = Shell.which("caddy") else { return }
        _ = try? await Shell.run(
            executable: caddyBin,
            arguments: ["validate", "--config", path.path, "--adapter", "caddyfile"]
        )
    }

    private func reloadCaddy() async {
        try? await BrewServices.restart("caddy")
    }

    private func regenerateCaddyfile() async {
        guard let config = configLoader.lastConfig else { return }
        _ = try? CaddyfileGenerator.write(config)
    }

    // MARK: - Helpers

    private func markState(_ id: String, _ state: ServiceState) {
        if let idx = services.firstIndex(where: { $0.id == id }) {
            services[idx].state = state
        }
    }

    private func runOsascript(_ script: String) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", script]
        try? task.run()
    }
}

struct CaddyServiceInfo: Hashable, Sendable {
    let running: Bool
    let configFile: URL?
}

enum CaddyAction: Hashable, Sendable {
    case start
    case stop
    case restart
    case reload
    case validate
    case openCaddyfile
    case revealCaddyfile
    case regenerate
}
