import Foundation
import MatisaCore
import AppKit

/// Engine-unreachable bodies for the lifecycle dispatch surface
/// (`start/stop/kill/restart/takeOver/pull`) plus the launch watcher
/// machinery that records crash-on-launch failures locally.
///
/// Pre-3 these lived inline on `ServiceStore`. They're moved here as a
/// `@MainActor extension ServiceStore` so the main store file is back to
/// just observable state, engine-first dispatch wrappers, and UI
/// affordances. Behaviour is unchanged from pre-3.
@MainActor
extension ServiceStore {

    // MARK: - Lifecycle (local fallback)

    func startLocal(_ service: Service) async {
        if !(await ensureDockerForLocal(action: .start, service: service)) { return }
        switch service.spec {
        case .project(let f):
            // Fresh attempt — drop any prior crash-on-launch capture for this
            // service so the UI doesn't keep showing yesterday's failure once
            // the user retries.
            launchFailures.removeValue(forKey: service.id)
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
                    serviceID: service.id,
                    extraEnv: f.env?.effective(activeContext: activeEnvContext) ?? [:]
                )
                let spawnedAt = Date()
                try? await Task.sleep(nanoseconds: 400_000_000)
                StatePersistence.upsert(PersistedSpawn(
                    serviceID: service.id,
                    pid: result.pid,
                    port: f.port,
                    startedAt: spawnedAt,
                    logPath: result.logURL.path
                ))
                markState(service.id, .running(pid: result.pid, since: spawnedAt))
                // Watch for early death — captures the cause when the process
                // crashes in the first ~10s without us noticing. After the
                // window expires the watcher exits silently; later deaths are
                // picked up by the regular refresh loop.
                watchProjectLaunch(
                    serviceID: service.id,
                    pid: result.pid,
                    logURL: result.logURL,
                    startedAt: spawnedAt
                )
            } catch {
                markState(service.id, .error(String(describing: error)))
            }

        case .docker(let f):
            // Fresh attempt — drop stale failure capture.
            launchFailures.removeValue(forKey: service.id)
            markState(service.id, .starting)
            let startedAt = Date()
            do {
                try await DockerProbe.inlineRun(image: f.image, name: f.name, port: f.port)
                markState(service.id, .running(pid: 0, since: startedAt))
            } catch {
                recordDockerFailure(serviceID: service.id, error: error, startedAt: startedAt)
            }

        case .compose(let f):
            launchFailures.removeValue(forKey: service.id)
            markState(service.id, .starting)
            let startedAt = Date()
            do {
                try await DockerProbe.composeUp(file: f.file)
                markState(service.id, .running(pid: 0, since: startedAt))
            } catch {
                recordDockerFailure(serviceID: service.id, error: error, startedAt: startedAt)
            }

        case .unmanaged(let f):
            if case let .container(name, _, _) = f.kind {
                try? await DockerProbe.unmanagedStart(name: name)
            }
        }
    }

    func stopLocal(_ service: Service) async {
        if !(await ensureDockerForLocal(action: .stop, service: service)) { return }
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
                try? await DockerProbe.unmanagedStop(name: name)
            }
        }
    }

    func killLocal(_ service: Service) async {
        if !(await ensureDockerForLocal(action: .kill, service: service)) { return }
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
            try? await DockerProbe.inlineKill(name: f.name)
            markState(service.id, .stopped)
        case .compose(let f):
            _ = try? await DockerProbe.composeDown(file: f.file)
            markState(service.id, .stopped)
        case .unmanaged(let f):
            switch f.kind {
            case let .process(pid, _, _, _):
                ProcessSupervisor.killForeign(pid: pid)
            case let .container(name, _, _):
                try? await DockerProbe.unmanagedKill(name: name)
            }
        }
    }

    func restartLocal(_ service: Service) async {
        if !(await ensureDockerForLocal(action: .restart, service: service)) { return }
        switch service.spec {
        case .project:
            // Stay on the local path: calling the engine-first `stop`/`start`
            // wrappers here would recurse into RPC attempts we already know
            // are going to fail (this branch only runs because the engine
            // wasn't reachable for `restart`).
            await stopLocal(service)
            try? await Task.sleep(nanoseconds: 500_000_000)
            if let updated = self.service(id: service.id) {
                await startLocal(updated)
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
    func takeOverLocal(_ service: Service) async {
        if !(await ensureDockerForLocal(action: .takeOver, service: service)) { return }
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
        await startLocal(service)
    }

    func pullLocal(_ service: Service) async {
        if !(await ensureDockerForLocal(action: .pull, service: service)) { return }
        switch service.spec {
        case .docker(let f):
            try? await DockerProbe.inlinePull(image: f.image)
        case .compose(let f):
            try? await DockerProbe.composePull(file: f.file)
        default:
            break
        }
    }

    // MARK: - Docker pre-gate

    /// Shared docker pre-gate for the local-fallback path. Returns true when
    /// the action is OK to proceed; returns false (and sets the UI prompt /
    /// state) when it isn't. Project actions skip the gate. Mirrors the
    /// previous `perform()`-level pre-check so the engine-down UX is
    /// indistinguishable from before 2c.3.
    func ensureDockerForLocal(action: ServiceAction, service: Service) async -> Bool {
        guard ServiceStore.actionNeedsDocker(action, service: service) else { return true }
        if dockerSystem.isStarting { return false }
        if !(await DockerProbe.daemonRunning()) {
            dockerSystem = .stopped
            pendingDockerPrompt = PendingDockerPrompt(
                serviceID: service.id,
                serviceName: service.name,
                action: action
            )
            return false
        }
        dockerSystem = .running
        return true
    }

    // MARK: - Launch watcher

    /// Polls the spawned project's PID for ~10s after launch. If it dies
    /// inside that window — typical for missing-dep / port-conflict /
    /// command-not-found failures — we read the tail of the log file and
    /// flip the service state to `.error(summary)` so the user sees the
    /// reason instead of the row silently snapping back to stopped.
    /// Detached so the polling sleeps don't run on the main actor.
    func watchProjectLaunch(
        serviceID: String,
        pid: Int32,
        logURL: URL,
        startedAt: Date
    ) {
        let watchSeconds: TimeInterval = 10
        let pollNS: UInt64 = 200_000_000
        Task.detached { [weak self] in
            let deadline = startedAt.addingTimeInterval(watchSeconds)
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: pollNS)
                if !ProcessSupervisor.isAlive(pid: pid) {
                    let alive = Date().timeIntervalSince(startedAt)
                    let tail = ServiceStore.readLogTail(url: logURL, lines: 10)
                    let summary = ServiceStore.summarizeFailure(tail: tail, aliveSeconds: alive)
                    let failure = LaunchFailure(
                        failedAt: Date(),
                        aliveSeconds: alive,
                        logTail: tail,
                        summary: summary
                    )
                    await self?.recordLaunchFailure(serviceID: serviceID, failure: failure)
                    return
                }
            }
        }
    }

    /// Mark the service as errored and stash the failure on the store so the
    /// UI can render the tooltip / callout. Called from the detached watcher.
    func recordLaunchFailure(serviceID: String, failure: LaunchFailure) {
        // Re-resolve the service: by the time we land back on main, the user
        // may have triggered another action — don't overwrite a fresh
        // .starting/.running with a stale failure.
        guard let svc = self.service(id: serviceID) else { return }
        switch svc.state {
        case .running, .stopped, .error:
            launchFailures[serviceID] = failure
            markState(serviceID, .error(failure.summary))
            // The persisted spawn record is no longer accurate (process is
            // dead) — drop it so it doesn't masquerade as live on next refresh.
            StatePersistence.remove(serviceID: serviceID)
        case .starting, .stopping, .unmanaged:
            // User has interacted — leave well alone.
            return
        }
    }

    /// Build a `LaunchFailure` from a thrown `ShellError` (or any other
    /// error) and stash it on the store. Used by `startLocal()` for compose
    /// and docker, where the failure mode is a non-zero exit from the docker
    /// CLI itself rather than a process that briefly ran. Sets state to
    /// `.error(summary)` — refresh may overwrite this to `.stopped` shortly,
    /// but the `launchFailures` entry is independent and keeps the red
    /// banner / sidebar pill visible until the user dismisses or retries.
    func recordDockerFailure(serviceID: String, error: Error, startedAt: Date) {
        let alive = Date().timeIntervalSince(startedAt)
        let (summary, tail): (String, String)
        if let shellError = error as? ShellError {
            switch shellError {
            case let .nonZeroExit(code, stderr):
                tail = stderr
                summary = ServiceStore.summarizeStderr(tail, exitCode: code, aliveSeconds: alive)
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
        let failure = LaunchFailure(
            failedAt: Date(),
            aliveSeconds: alive,
            logTail: tail,
            summary: summary
        )
        launchFailures[serviceID] = failure
        markState(serviceID, .error(summary))
    }
}

// MARK: - Launch-watcher helpers (nonisolated)
//
// These read string data only — `nonisolated static` so the detached
// watcher Task can call them without hopping back to the main actor for
// the log tail / summary computation.
extension ServiceStore {

    /// One-line summary for a non-zero docker CLI exit. Picks the last
    /// non-blank stderr line (where the actual error message lives) and
    /// prepends the alive-time so the user can tell "rejected immediately"
    /// from "tried for a while then gave up".
    nonisolated static func summarizeStderr(_ stderr: String, exitCode: Int32, aliveSeconds: TimeInterval) -> String {
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

    /// Read the last `lines` lines of the service's log file. Returns "" if
    /// the file is missing or unreadable. Mapped read keeps it cheap even
    /// if the file is large.
    nonisolated static func readLogTail(url: URL, lines: Int) -> String {
        guard let data = try? Data(contentsOf: url, options: .alwaysMapped) else {
            return ""
        }
        guard let s = String(data: data, encoding: .utf8) else { return "" }
        let split = s.split(separator: "\n", omittingEmptySubsequences: false)
        return split.suffix(lines).joined(separator: "\n")
    }

    /// One-line summary for the `.error(...)` state label and tooltip.
    /// Pulls the last non-blank line of the log tail and prepends the
    /// alive-time so users can tell "died on launch" from "ran briefly".
    nonisolated static func summarizeFailure(tail: String, aliveSeconds: TimeInterval) -> String {
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
}
