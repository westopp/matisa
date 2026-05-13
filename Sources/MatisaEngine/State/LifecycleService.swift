import Foundation
import MatisaCore

/// Engine-side orchestrator for service lifecycle actions. Wires together
/// `LifecycleSupervisor` (posix_spawn + signal escalation), `DockerActions`
/// (docker/compose CLI), and `PersistedSpawnStore` (the on-disk spawn list).
/// Same semantics as the app's `ServiceStore` lifecycle methods today —
/// 2c.3 cuts the app over to this surface via RPC.
///
/// Service-resolution uses an injected `lookupService` closure so tests don't
/// need to drive a real `ConfigService` / bun eval. Production wiring passes
/// in a closure that calls `ServicesService.lookup(serviceID:)`.
///
/// **Known limitation — zombie blindness.** The launch watcher polls
/// `LifecycleSupervisor.isAlive(pid:)`, which is a `kill(pid, 0)` probe.
/// Since the engine never `waitpid`s on its spawned children, an exited
/// child remains a zombie indefinitely and `isAlive` keeps returning true.
/// Quick-exit failures (the very case the watcher exists to catch) may go
/// unrecorded as a result. Parity with the app's `ServiceStore.watchProjectLaunch`
/// — same bug, inherited. The fix is either a SIGCHLD reaper or per-PID
/// `kqueue` NOTE_EXIT registration; tracked for a future phase.
final class LifecycleService: @unchecked Sendable {

    /// Resolves a service id to the merged `Service` (config + state).
    /// Returns nil for unknown ids; the caller maps that to `serviceNotFound`.
    /// Throws when the underlying config load fails — surfaces as
    /// `RPCError.internalError`.
    typealias ServiceLookup = @Sendable (String) throws -> Service?

    private let lookupService: ServiceLookup
    private let spawnStore: PersistedSpawnStore
    private let activeEnvContext: () -> String?
    private let dockerDaemonProbe: @Sendable () -> Bool

    /// Per-service launch failures. Captured by the launch-watcher when a
    /// project process dies inside the 10s observation window, and by the
    /// docker-failure path when the CLI returns non-zero. Transient.
    private let failuresQueue = DispatchQueue(label: "engine.lifecycle.failures")
    private var failures: [String: LaunchFailure] = [:]

    /// In-flight launch-watcher tasks, keyed by serviceID. Guarded by
    /// `failuresQueue`. Stored so a second `start` (user retry, or the start
    /// half of a restart) can cancel the previous watcher before its 10s
    /// window expires — otherwise the stale watcher races the fresh attempt
    /// and may write a stale `LaunchFailure` after the new start cleared it,
    /// or worse, call `spawnStore.remove(serviceID:)` and delete the *new*
    /// spawn record (removal is keyed by serviceID, not PID). On natural
    /// (deadline-elapsed) exit the entry is left in the map — completed
    /// `Task.cancel()` is a no-op, and the next `start` evicts it.
    private var activeWatchers: [String: Task<Void, Never>] = [:]

    init(
        lookupService: @escaping ServiceLookup,
        spawnStore: PersistedSpawnStore,
        activeEnvContext: @escaping () -> String? = { nil },
        dockerDaemonProbe: @escaping @Sendable () -> Bool = { SyncDocker.daemonRunning() }
    ) {
        self.lookupService = lookupService
        self.spawnStore = spawnStore
        self.activeEnvContext = activeEnvContext
        self.dockerDaemonProbe = dockerDaemonProbe
    }

    // MARK: - Failure tracker (thread-safe via serial queue)

    func listLaunchFailures() -> [String: LaunchFailure] {
        failuresQueue.sync { failures }
    }

    func clearLaunchFailure(serviceID: String) {
        failuresQueue.sync { _ = failures.removeValue(forKey: serviceID) }
    }

    private func recordFailure(serviceID: String, failure: LaunchFailure) {
        failuresQueue.sync { failures[serviceID] = failure }
    }

    private func dropFailure(serviceID: String) {
        failuresQueue.sync { _ = failures.removeValue(forKey: serviceID) }
    }

    // MARK: - Actions

    /// Returns when the underlying spawn / CLI call has accepted. For project
    /// services that means posix_spawn returned a PID; for docker/compose it
    /// means the CLI exited 0. Fires a detached launch-watcher Task for
    /// project services internally — that watcher may later record a
    /// LaunchFailure even though this method already returned ok.
    func start(serviceID: String) async throws {
        let service = try requireService(serviceID)
        try ensureDockerIfNeeded(action: .start, service: service)
        // Fresh attempt — drop any prior failure capture so the UI doesn't
        // keep showing yesterday's crash once the user retries.
        dropFailure(serviceID: serviceID)

        switch service.spec {
        case .project(let f):
            try startProject(service: service, fields: f)
        case .docker(let f):
            try await startDocker(service: service, fields: f)
        case .compose(let f):
            try await startCompose(service: service, fields: f)
        case .unmanaged(let f):
            if case let .container(name, _, _) = f.kind {
                try await DockerActions.unmanagedStart(name: name)
            }
            // Unmanaged processes have no start path — there's nothing for us
            // to spawn.
        }
    }

    func stop(serviceID: String) async throws {
        let service = try requireService(serviceID)
        try ensureDockerIfNeeded(action: .stop, service: service)

        switch service.spec {
        case .project:
            // Cancel any in-flight launch watcher — otherwise a user-initiated
            // stop within the 10s window lets the watcher record a spurious
            // "exited after Xs" LaunchFailure for the user's own action.
            cancelWatcher(serviceID: serviceID)
            switch service.state {
            case let .running(pid, _):
                await LifecycleSupervisor.stopWithEscalation(pid: pid)
                spawnStore.remove(serviceID: serviceID)
            case let .unmanaged(pid):
                await LifecycleSupervisor.stopWithEscalation(pid: pid, foreign: true)
            default:
                break
            }
        case .docker(let f):
            // LaunchFailure is for launch attempts; a stop that errors is not
            // a launch failure. Re-throw and let the caller surface the error.
            // Matches the app's `ServiceStore.stop`, which uses `try? await` —
            // failures don't update the state's `.error(...)` either.
            try await DockerActions.inlineStop(name: f.name)
        case .compose(let f):
            try await DockerActions.composeDown(file: f.file)
        case .unmanaged(let f):
            switch f.kind {
            case let .process(pid, _, _, _):
                await LifecycleSupervisor.stopWithEscalation(pid: pid, foreign: true)
            case let .container(name, _, _):
                try await DockerActions.unmanagedStop(name: name)
            }
        }
    }

    func kill(serviceID: String) async throws {
        let service = try requireService(serviceID)
        try ensureDockerIfNeeded(action: .kill, service: service)

        switch service.spec {
        case .project:
            // Cancel any in-flight launch watcher before killing — same reason
            // as `stop`: a kill within the 10s window would let the watcher
            // record a spurious launch failure for the user's own action.
            cancelWatcher(serviceID: serviceID)
            if let pid = service.state.pid, pid > 0 {
                let foreign = service.isRunningUnmanaged
                if foreign {
                    _ = LifecycleSupervisor.killForeign(pid: pid)
                } else {
                    _ = LifecycleSupervisor.forceKill(pid: pid)
                }
                spawnStore.remove(serviceID: serviceID)
            }
        case .docker(let f):
            try await DockerActions.inlineKill(name: f.name)
        case .compose(let f):
            // Compose has no `kill`; closest match is `down` (the app does
            // the same — see ServiceStore.kill).
            try await DockerActions.composeDown(file: f.file)
        case .unmanaged(let f):
            switch f.kind {
            case let .process(pid, _, _, _):
                _ = LifecycleSupervisor.killForeign(pid: pid)
            case let .container(name, _, _):
                try await DockerActions.unmanagedKill(name: name)
            }
        }
    }

    func restart(serviceID: String) async throws {
        let service = try requireService(serviceID)
        try ensureDockerIfNeeded(action: .restart, service: service)

        switch service.spec {
        case .project:
            try await stop(serviceID: serviceID)
            try? await Task.sleep(nanoseconds: 500_000_000)
            try await start(serviceID: serviceID)
        case .docker(let f):
            try await DockerActions.inlineRestart(name: f.name)
        case .compose(let f):
            try await DockerActions.composeRestart(file: f.file)
        case .unmanaged:
            break
        }
    }

    /// Take over a managed service currently running unmanaged: stop the
    /// foreign PID then spawn under our supervisor. Only meaningful for
    /// project services — for docker/compose the "running unmanaged" case
    /// means something else has the port and we can only stop it.
    func takeOver(serviceID: String) async throws {
        let service = try requireService(serviceID)
        try ensureDockerIfNeeded(action: .takeOver, service: service)

        guard case let .unmanaged(pid) = service.state else { return }
        guard case .project = service.spec else {
            await LifecycleSupervisor.stopWithEscalation(pid: pid, foreign: true)
            return
        }
        await LifecycleSupervisor.stopWithEscalation(pid: pid, foreign: true)
        try? await Task.sleep(nanoseconds: 400_000_000)
        try await start(serviceID: serviceID)
    }

    func pull(serviceID: String) async throws {
        let service = try requireService(serviceID)
        try ensureDockerIfNeeded(action: .pull, service: service)

        switch service.spec {
        case .docker(let f):
            try await DockerActions.inlinePull(image: f.image)
        case .compose(let f):
            try await DockerActions.composePull(file: f.file)
        case .project, .unmanaged:
            break
        }
    }

    // MARK: - Project start helpers

    private func startProject(service: Service, fields f: ProjectFields) throws {
        // Fail loudly on path typos rather than letting posix_spawn return
        // ENOENT silently. Match the app's preflight (ServiceStore.start).
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: f.path.path, isDirectory: &isDir)
        if !exists || !isDir.boolValue {
            let msg = "path not found: \(f.path.path)"
            writePreflightLog(serviceID: service.id, message: msg)
            throw RPCError.invalidParams(msg)
        }

        let result = try LifecycleSupervisor.spawnDetached(
            shellCommand: f.command,
            workingDirectory: f.path,
            serviceID: service.id,
            extraEnv: f.env?.effective(activeContext: activeEnvContext()) ?? [:]
        )
        let spawnedAt = Date()
        spawnStore.upsert(PersistedSpawn(
            serviceID: service.id,
            pid: result.pid,
            port: f.port,
            startedAt: spawnedAt,
            logPath: result.logURL.path
        ))
        watchProjectLaunch(
            serviceID: service.id,
            pid: result.pid,
            logURL: result.logURL,
            startedAt: spawnedAt
        )
    }

    private func startDocker(service: Service, fields f: DockerFields) async throws {
        let startedAt = Date()
        do {
            try await DockerActions.inlineRun(image: f.image, name: f.name, port: f.port)
        } catch {
            recordDockerFailure(serviceID: service.id, error: error, startedAt: startedAt)
            throw error
        }
    }

    private func startCompose(service: Service, fields f: ComposeFields) async throws {
        let startedAt = Date()
        do {
            try await DockerActions.composeUp(file: f.file)
        } catch {
            recordDockerFailure(serviceID: service.id, error: error, startedAt: startedAt)
            throw error
        }
    }

    /// Write a `[matisa] ...` preamble to the service's log when we refuse
    /// to spawn (e.g. path not found). Same shape the app writes today.
    private func writePreflightLog(serviceID: String, message: String) {
        let log = CorePaths.logFile(for: serviceID)
        guard let data = "[matisa] \(message)\n".data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: data)
        } else if let h = try? FileHandle(forWritingTo: log) {
            h.seekToEndOfFile(); h.write(data); try? h.close()
        }
    }

    // MARK: - Launch watcher

    /// Poll the spawned project's PID for ~10s. If it dies inside that
    /// window — typical for missing-dep / port-conflict / command-not-found —
    /// read the log tail and stash a `LaunchFailure`. The watcher exits
    /// silently after the window; later deaths are picked up by the regular
    /// snapshot loop's `deadSpawnIDs` cleanup.
    ///
    /// Stores its `Task` in `activeWatchers` so a subsequent `start`/`stop`/
    /// `kill` for the same id can cancel it. Inside the loop, every iteration
    /// checks `Task.isCancelled` and (before recording a failure) verifies
    /// the persisted spawn still points at our PID — both defences are
    /// needed because the cancel signal can race the wakeup from
    /// `Task.sleep`.
    private func watchProjectLaunch(
        serviceID: String,
        pid: Int32,
        logURL: URL,
        startedAt: Date
    ) {
        let watchSeconds: TimeInterval = 10
        let pollNS: UInt64 = 200_000_000
        let spawnStore = self.spawnStore
        let watchedPid = pid
        let task = Task.detached { [weak self] () -> Void in
            let deadline = startedAt.addingTimeInterval(watchSeconds)
            while Date() < deadline {
                if Task.isCancelled { return }
                try? await Task.sleep(nanoseconds: pollNS)
                if Task.isCancelled { return }
                if !LifecycleSupervisor.isAlive(pid: watchedPid) {
                    // PID-identity guard: only proceed if the persisted spawn
                    // still points at *our* pid. A user-initiated restart or
                    // take-over replaces the spawn record with a fresh pid;
                    // we must not stomp on it (the LaunchFailure would be
                    // stale, and `spawnStore.remove(serviceID:)` would delete
                    // the new spawn since removal is keyed by serviceID).
                    guard
                        spawnStore.spawns()
                            .first(where: { $0.serviceID == serviceID })?
                            .pid == watchedPid
                    else { return }
                    let alive = Date().timeIntervalSince(startedAt)
                    let tail = Self.readLogTail(url: logURL, lines: 10)
                    let summary = Self.summarizeFailure(tail: tail, aliveSeconds: alive)
                    let failure = LaunchFailure(
                        failedAt: Date(),
                        aliveSeconds: alive,
                        logTail: tail,
                        summary: summary
                    )
                    self?.recordFailure(serviceID: serviceID, failure: failure)
                    // The persisted spawn record is no longer accurate (PID is
                    // dead). Drop it so it doesn't masquerade as live on the
                    // next snapshot.
                    spawnStore.remove(serviceID: serviceID)
                    return
                }
            }
        }
        // Cancel any prior watcher for this id and install ours, atomically
        // under the failuresQueue. The prior watcher's `isCancelled` check
        // will trip on its next wakeup.
        failuresQueue.sync {
            activeWatchers[serviceID]?.cancel()
            activeWatchers[serviceID] = task
        }
    }

    /// Cancel the in-flight watcher (if any) for this id and forget it.
    /// Used by `stop`/`kill` so user-initiated termination within the 10s
    /// window doesn't surface as a "launch failure".
    private func cancelWatcher(serviceID: String) {
        failuresQueue.sync {
            activeWatchers[serviceID]?.cancel()
            activeWatchers.removeValue(forKey: serviceID)
        }
    }

    /// Convert a thrown `ShellError` (or any error) from a docker CLI call
    /// into a `LaunchFailure` and stash it. Re-throw is the caller's job.
    private func recordDockerFailure(serviceID: String, error: Error, startedAt: Date) {
        let alive = Date().timeIntervalSince(startedAt)
        let (summary, tail): (String, String)
        if let shellError = error as? ShellError {
            switch shellError {
            case let .nonZeroExit(code, stderr):
                tail = stderr
                summary = Self.summarizeStderr(stderr, exitCode: code, aliveSeconds: alive)
            case let .timedOut(after):
                tail = ""
                summary = "timed out after \(String(format: "%.0fs", after))"
            case let .spawnFailed(msg):
                tail = ""
                summary = "spawn failed: \(msg)"
            }
        } else {
            tail = ""
            summary = String(describing: error)
        }
        recordFailure(serviceID: serviceID, failure: LaunchFailure(
            failedAt: Date(),
            aliveSeconds: alive,
            logTail: tail,
            summary: summary
        ))
    }

    // MARK: - Service resolution & docker gating

    private func requireService(_ id: String) throws -> Service {
        guard let svc = try lookupService(id) else {
            throw RPCError.serviceNotFound("unknown service: \(id)")
        }
        return svc
    }

    private enum GatedAction { case start, stop, kill, restart, pull, takeOver }

    /// Same predicate as the app's `ServiceStore.actionNeedsDocker`. When the
    /// daemon is down we throw `dockerDaemonRequired` — the app picks this up
    /// in 2c.3 and replays via its existing `pendingDockerPrompt` flow.
    private func ensureDockerIfNeeded(action: GatedAction, service: Service) throws {
        guard Self.actionNeedsDocker(action, service: service) else { return }
        if dockerDaemonProbe() { return }
        throw RPCError.dockerDaemonRequired(
            "Docker daemon is not running; cannot \(action) \(service.id)"
        )
    }

    private static func actionNeedsDocker(_ action: GatedAction, service: Service) -> Bool {
        let dockerActions: Set<GatedAction> = [.start, .stop, .restart, .pull, .takeOver, .kill]
        switch service.spec {
        case .docker, .compose:
            return dockerActions.contains(action)
        case .project:
            return false
        case .unmanaged(let f):
            switch f.kind {
            case .container: return [.start, .stop, .kill].contains(action)
            case .process:   return false
            }
        }
    }

    // MARK: - Failure summarisers (ported from ServiceStore)

    private static func readLogTail(url: URL, lines: Int) -> String {
        guard let data = try? Data(contentsOf: url, options: .alwaysMapped) else {
            return ""
        }
        guard let s = String(data: data, encoding: .utf8) else { return "" }
        let split = s.split(separator: "\n", omittingEmptySubsequences: false)
        return split.suffix(lines).joined(separator: "\n")
    }

    private static func summarizeFailure(tail: String, aliveSeconds: TimeInterval) -> String {
        let lastLine = tail
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { !$0.isEmpty })
        let timeStr = String(format: "%.1fs", aliveSeconds)
        if let line = lastLine, !line.isEmpty {
            let maxChars = 100
            let shortened = line.count > maxChars
                ? String(line.prefix(maxChars - 1)) + "…"
                : line
            return "exited after \(timeStr): \(shortened)"
        }
        return "exited after \(timeStr) — no output"
    }

    private static func summarizeStderr(_ stderr: String, exitCode: Int32, aliveSeconds: TimeInterval) -> String {
        let timeStr = String(format: "%.1fs", aliveSeconds)
        let lastLine = stderr
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { !$0.isEmpty })
        if let line = lastLine, !line.isEmpty {
            let maxChars = 100
            let shortened = line.count > maxChars
                ? String(line.prefix(maxChars - 1)) + "…"
                : line
            return "exit \(exitCode) after \(timeStr): \(shortened)"
        }
        return "exit \(exitCode) after \(timeStr) — no output"
    }
}
