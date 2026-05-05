import Foundation
import Observation
import Darwin

/// Runs ad-hoc build / script commands per service. At most one of each kind
/// can run per service at a time. Output is buffered in-memory only — when
/// the user closes the pane (or invokes a new run), the buffer is discarded.
///
/// Tasks here intentionally do *not* persist across an app restart, unlike
/// the long-lived project processes in `ProcessSupervisor`. That keeps the
/// model simple: a build is a foreground activity tied to the running app.
@MainActor
@Observable
final class TaskRunner {
    enum TaskKind: String, Hashable, Sendable {
        case build
        case script
    }

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

    /// Outer key is service id (e.g. `project:web`); inner key is the task kind.
    private(set) var slots: [String: [TaskKind: TaskSlot]] = [:]

    /// Cap on retained output per slot. Keeps memory bounded for chatty builds.
    private let bufferCap = 200_000

    // MARK: - Reads

    func slot(_ serviceID: String, _ kind: TaskKind) -> TaskSlot {
        slots[serviceID]?[kind] ?? TaskSlot()
    }

    func isPaneVisible(_ serviceID: String, _ kind: TaskKind) -> Bool {
        slot(serviceID, kind).state != .idle
    }

    // MARK: - Mutations

    private func mutate(
        _ serviceID: String,
        _ kind: TaskKind,
        _ block: (inout TaskSlot) -> Void
    ) {
        var inner = slots[serviceID] ?? [:]
        var s = inner[kind] ?? TaskSlot()
        block(&s)
        inner[kind] = s
        slots[serviceID] = inner
    }

    // MARK: - Lifecycle

    /// Start a command. No-op if a task of the same kind is already running
    /// for this service.
    func start(
        serviceID: String,
        kind: TaskKind,
        name: String,
        command: String,
        cwd: URL,
        extraEnv: [String: String] = [:]
    ) {
        if slot(serviceID, kind).state.isRunning { return }

        // Reset slot to a fresh running state.
        mutate(serviceID, kind) {
            $0.state = .running(name: name, since: Date())
            $0.buffer = ""
            $0.pid = 0
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        let cwdEscaped = cwd.path.replacingOccurrences(of: "'", with: "'\\''")
        let wrapper = "cd '\(cwdEscaped)' && exec \(command)"
        process.arguments = ["-l", "-c", wrapper]
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
                self?.append(serviceID: serviceID, kind: kind, text: text)
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
                self?.markExited(serviceID: serviceID, kind: kind, code: code)
            }
        }

        do {
            try process.run()
            mutate(serviceID, kind) { $0.pid = process.processIdentifier }
        } catch {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            append(
                serviceID: serviceID, kind: kind,
                text: "[matisa] failed to start: \(error)\n"
            )
            markExited(serviceID: serviceID, kind: kind, code: -1)
        }
    }

    /// SIGTERM the running task, escalating to SIGKILL after a grace period.
    /// We signal the PID directly — these tasks share our process group, so
    /// `killpg` would also kill matisa.
    func stop(serviceID: String, kind: TaskKind) {
        let s = slot(serviceID, kind)
        guard case .running = s.state, s.pid > 0 else { return }
        let pid = s.pid
        Task.detached {
            await ProcessSupervisor.stopWithEscalation(pid: pid, foreign: true)
        }
    }

    /// Wipe the buffer without stopping the process.
    func clear(serviceID: String, kind: TaskKind) {
        mutate(serviceID, kind) { $0.buffer = "" }
    }

    /// Close the pane. Only valid when not running. Discards the buffer and
    /// returns the slot to `.idle`.
    func closePane(serviceID: String, kind: TaskKind) {
        let s = slot(serviceID, kind)
        if case .running = s.state { return }
        mutate(serviceID, kind) {
            $0.state = .idle
            $0.buffer = ""
            $0.pid = 0
        }
    }

    // MARK: - Internal callbacks

    private func append(serviceID: String, kind: TaskKind, text: String) {
        mutate(serviceID, kind) { s in
            s.buffer += text
            if s.buffer.count > bufferCap {
                s.buffer = String(s.buffer.suffix(bufferCap))
            }
        }
    }

    private func markExited(serviceID: String, kind: TaskKind, code: Int32) {
        mutate(serviceID, kind) { s in
            if case .running(let name, let since) = s.state {
                s.state = .exited(name: name, code: code, since: since)
            }
            s.pid = 0
        }
    }
}
