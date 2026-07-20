import Foundation
import MatisaCore
import Observation
import Darwin

/// Runs ad-hoc named commands per service. The unified commands surface —
/// builds, tests, lints, anything wired up under a service's `commands:`
/// block — all live here, keyed by command name. Output is buffered
/// in-memory only; closing the pane (or invoking a new run) discards it.
///
/// Tasks here intentionally do *not* persist across an app restart, unlike
/// the long-lived project processes in `ProcessSupervisor`. That keeps the
/// model simple: a build is a foreground activity tied to the running app.
///
/// From phase 2e.3 onwards this is the local-fallback path. The primary path
/// runs in the engine's `TaskService`; `ServiceStore.refresh()` polls
/// `tasks.list(id)` for services with a visible pane and mirrors the engine's
/// view into our `slots` via `replaceSlotsFromEngine` so the SwiftUI bindings
/// keep working without rewriting every view.
///
/// Concurrency: at most `TaskLimits.maxRunningCommands` (2) commands per service can
/// run at the same time. The supervised long-running `command:` (the dev
/// server) does not count toward this cap. The runner enforces the cap
/// defensively; the UI is the authoritative gate (it disables further
/// menu entries when the cap is hit).
@MainActor
@Observable
final class TaskRunner {
    enum TaskState: Hashable, Sendable {
        /// Pane closed, no buffer.
        case idle
        /// A command is currently running.
        case running(name: String, since: Date)
        /// Last run finished. Buffer retained until the user closes the pane.
        case exited(name: String, code: Int32, since: Date)

        var isRunning: Bool {
            if case .running = self { return true }
            return false
        }
    }

    struct TaskSlot: Hashable, Sendable {
        var state: TaskState = .idle
        var buffer: String = ""
        // The Process is referenced by class identity; we don't compare it
        // for Hashable/Equatable (it lives only while running).
        fileprivate var pid: pid_t = 0
    }

    /// Outer key is service id (e.g. `project:web`); inner key is the
    /// command name (the user-visible label from the service's `commands:`).
    private(set) var slots: [String: [String: TaskSlot]] = [:]

    /// Cap on retained output per slot. Keeps memory bounded for chatty builds.
    private let bufferCap = 200_000

    // MARK: - Reads

    func slot(_ serviceID: String, _ name: String) -> TaskSlot {
        slots[serviceID]?[name] ?? TaskSlot()
    }

    func isPaneVisible(_ serviceID: String, _ name: String) -> Bool {
        slot(serviceID, name).state != .idle
    }

    /// True if any command for this service has a visible pane (i.e. any
    /// slot is not `.idle`). Used by the refresh poller to decide whether
    /// to issue `tasks.list(id)` for the service.
    func hasAnyVisiblePane(_ serviceID: String) -> Bool {
        (slots[serviceID] ?? [:]).values.contains { $0.state != .idle }
    }

    /// Number of slots currently in the running state for a service.
    /// Used by the UI to decide whether to disable further command menu
    /// entries (cap is `TaskLimits.maxRunningCommands`).
    func runningCount(_ serviceID: String) -> Int {
        (slots[serviceID] ?? [:]).values
            .reduce(into: 0) { $0 += $1.state.isRunning ? 1 : 0 }
    }

    /// Convenience: are we already at the per-service cap?
    func atRunningCap(_ serviceID: String) -> Bool {
        runningCount(serviceID) >= TaskLimits.maxRunningCommands
    }

    /// All slots whose pane is visible (i.e. not `.idle`), keyed by name.
    /// The detail view enumerates these to render the right-side panes.
    func visibleSlots(_ serviceID: String) -> [(name: String, slot: TaskSlot)] {
        (slots[serviceID] ?? [:])
            .filter { $0.value.state != .idle }
            .sorted(by: { $0.key < $1.key })
            .map { (name: $0.key, slot: $0.value) }
    }

    // MARK: - Mutations

    private func mutate(
        _ serviceID: String,
        _ name: String,
        _ block: (inout TaskSlot) -> Void
    ) {
        var inner = slots[serviceID] ?? [:]
        var s = inner[name] ?? TaskSlot()
        block(&s)
        inner[name] = s
        slots[serviceID] = inner
    }

    // MARK: - Lifecycle

    /// Start a command. No-op if a command of the same `name` is already
    /// running for this service, or if the service is at the running cap.
    func start(
        serviceID: String,
        name: String,
        command: String,
        cwd: URL,
        extraEnv: [String: String] = [:]
    ) {
        if slot(serviceID, name).state.isRunning { return }
        if atRunningCap(serviceID) { return }

        // Reset slot to a fresh running state.
        mutate(serviceID, name) {
            $0.state = .running(name: name, since: Date())
            $0.buffer = ""
            $0.pid = 0
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        let cwdEscaped = cwd.path.replacingOccurrences(of: "'", with: "'\\''")
        // `-i -l` so `.zshrc` loads (PATH for bun/nvm/etc. lives there for
        // most users). Re-export extraEnv *after* `.zshrc` to preserve
        // services.ts precedence over any `.zshrc` exports.
        let envPrefix = ProcessSupervisor.shellExports(for: extraEnv)
        let wrapper = "\(envPrefix)cd '\(cwdEscaped)' && exec \(command)"
        process.arguments = ["-i", "-l", "-c", wrapper]
        // Encourage colored output even though stdout/stderr are pipes.
        var env = ProcessInfo.processInfo.environment
        env["FORCE_COLOR"] = env["FORCE_COLOR"] ?? "1"
        env["CLICOLOR_FORCE"] = env["CLICOLOR_FORCE"] ?? "1"
        env["TERM"] = env["TERM"] ?? "xterm-256color"
        // User-declared env wins over inherited values.
        for (k, v) in extraEnv { env[k] = v }
        process.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        if let devNull = FileHandle(forReadingAtPath: "/dev/null") {
            process.standardInput = devNull
        }

        // Both pipes feed the same buffer — interleave is good enough.
        let onChunk: @Sendable (FileHandle) -> Void = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { return }
            let text = String(data: data, encoding: .utf8) ?? ""
            Task { @MainActor [weak self] in
                self?.append(serviceID: serviceID, name: name, text: text)
            }
        }
        outPipe.fileHandleForReading.readabilityHandler = onChunk
        errPipe.fileHandleForReading.readabilityHandler = onChunk

        process.terminationHandler = { [weak self] proc in
            // Stop draining and capture the exit on the main actor.
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            let code = proc.terminationStatus
            Task { @MainActor [weak self] in
                self?.markExited(serviceID: serviceID, name: name, code: code)
            }
        }

        do {
            try process.run()
            mutate(serviceID, name) { $0.pid = process.processIdentifier }
        } catch {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            append(
                serviceID: serviceID, name: name,
                text: "[matisa] failed to start: \(error)\n"
            )
            markExited(serviceID: serviceID, name: name, code: -1)
        }
    }

    /// SIGTERM the running task, escalating to SIGKILL after a grace period.
    /// We signal the PID directly — these tasks share our process group, so
    /// `killpg` would also kill matisa.
    func stop(serviceID: String, name: String) {
        let s = slot(serviceID, name)
        guard case .running = s.state, s.pid > 0 else { return }
        let pid = s.pid
        Task.detached {
            await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
        }
    }

    /// Wipe the buffer without stopping the process.
    func clear(serviceID: String, name: String) {
        mutate(serviceID, name) { $0.buffer = "" }
    }

    /// Close the pane. Only valid when not running. Discards the buffer and
    /// returns the slot to `.idle`.
    func closePane(serviceID: String, name: String) {
        let s = slot(serviceID, name)
        if case .running = s.state { return }
        mutate(serviceID, name) {
            $0.state = .idle
            $0.buffer = ""
            $0.pid = 0
        }
    }

    // MARK: - Internal callbacks

    private func append(serviceID: String, name: String, text: String) {
        mutate(serviceID, name) { s in
            s.buffer += text
            if s.buffer.count > bufferCap {
                s.buffer = String(s.buffer.suffix(bufferCap))
            }
        }
    }

    private func markExited(serviceID: String, name: String, code: Int32) {
        mutate(serviceID, name) { s in
            if case .running(let n, let since) = s.state {
                s.state = .exited(name: n, code: code, since: since)
            }
            s.pid = 0
        }
    }

    // MARK: - Engine mirror (phase 2e.3)
    //
    // When the engine owns a task, the app polls `tasks.list(id)` during
    // `refresh()` and pushes the result back here so the existing SwiftUI
    // bindings keep working. The engine's wire slot has no PID (process
    // management is engine-internal); we mirror in `pid: 0`. Cancellation,
    // clear, and closePane on engine-driven slots all go through RPC and
    // come back via the next poll — the local stop/clear/closePane paths
    // are only invoked on the engine-unreachable fallback.

    /// Map a MatisaCore wire slot to the runner's local slot, dropping the
    /// engine-side PID detail.
    private static func localSlot(_ wire: MatisaCore.TaskSlot) -> TaskSlot {
        var s = TaskSlot()
        s.buffer = wire.buffer
        switch wire.state {
        case .idle:
            s.state = .idle
        case let .running(name, since):
            s.state = .running(name: name, since: since)
        case let .exited(name, code, since):
            s.state = .exited(name: name, code: code, since: since)
        }
        return s
    }

    /// Replace the slots for one service with the engine's view, wholesale.
    /// Names present in `wire` overwrite local entries; names *absent* from
    /// `wire` are dropped — **except for slots whose `pid > 0`**, which were
    /// spawned on the local-fallback path during an engine-unreachable
    /// window. Those processes are still alive on this app; the engine has
    /// no record of them. Wiping them would orphan the Process and leave
    /// the user with no UI handle to cancel it (the local `stop` reads pid
    /// from the slot map, so a missing entry would silently no-op).
    func replaceSlotsFromEngine(serviceID: String, wire: [String: MatisaCore.TaskSlot]) {
        let existing = slots[serviceID] ?? [:]
        var next: [String: TaskSlot] = [:]
        // Preserve any locally-spawned slots — their pid > 0 marks them as
        // app-owned, not engine-owned.
        for (k, v) in existing where v.pid > 0 {
            next[k] = v
        }
        // Overlay the engine's view. The engine doesn't know about locally
        // spawned tasks, so it won't have entries for them; engine-owned
        // slots always have pid == 0 (set by `localSlot`).
        for (k, v) in wire {
            next[k] = Self.localSlot(v)
        }
        if next.isEmpty {
            slots.removeValue(forKey: serviceID)
        } else {
            slots[serviceID] = next
        }
    }

    /// Write a placeholder `.running` slot for `(serviceID, name)`. Called
    /// by `ServiceStore.runCommand` right after the engine accepts a
    /// `tasks.start` RPC, so `isPaneVisible` flips to `true` before the
    /// next refresh tick mirrors the engine's real state in. Without this
    /// bootstrap the next poll wouldn't fire — refresh only queries
    /// `tasks.list` for slots whose pane is already visible.
    func writeEnginePlaceholder(serviceID: String, name: String) {
        mutate(serviceID, name) {
            $0.state = .running(name: name, since: Date())
            $0.buffer = ""
            $0.pid = 0
        }
    }
}
