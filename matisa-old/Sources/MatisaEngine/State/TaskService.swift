import Foundation
import Darwin
import MatisaCore

/// Engine-side ad-hoc command runner. Owns the per-(serviceID, commandName)
/// slot map for the unified commands surface (builds, tests, lints — anything
/// the user wires up under a service's `commands:` block).
///
/// Semantics:
///
///   - **Per-name idempotency.** A second `start` of the same command name
///     while one is already running is silently dropped.
///   - **Per-service concurrency cap.** At most `TaskLimits.maxRunningCommands` (2)
///     commands per service can run at the same time. A third `start` is
///     silently dropped — the UI is responsible for disabling the menu
///     items, the engine just refuses defensively. The supervised
///     long-running `command:` does not count toward this cap.
///   - **Survival.** Running commands are not killed when the service's
///     supervised `command:` stops or restarts. They keep running until
///     the user stops them explicitly (via menu, pane stop button, or
///     `cancel` RPC).
///   - Stdout + stderr are interleaved into a single in-memory buffer,
///     capped at `bufferCap` bytes (the oldest are dropped on overflow).
///   - On exit, the slot transitions `running(name, since) → exited(name,
///     code, since)`. The buffer is retained until `closePane` (or the
///     next `start` for that name).
///   - `cancel` SIGTERMs the child directly (these tasks share the
///     engine's process group, so `killpg` would also kill the engine),
///     escalating to SIGKILL via `LifecycleSupervisor.stopWithEscalation`.
///
/// Marked `@unchecked Sendable`: a serial `DispatchQueue` (`engine.tasks`)
/// guards all mutable state — the `slots` map plus the running `Process`
/// handles. `Process` pipe callbacks (`readabilityHandler`,
/// `terminationHandler`) arrive on Foundation worker threads and marshal
/// back onto the queue before touching any state.
final class TaskService: @unchecked Sendable {

    private let queue = DispatchQueue(label: "engine.tasks")

    /// Outer key is service id; inner key is the command name. Mirrors the
    /// `TaskList` wire shape exactly.
    private var slots: [String: [String: TaskSlot]] = [:]

    /// Live Process handles, keyed by (serviceID, commandName). Kept
    /// separate from the wire-visible `slots` map so the wire type can stay
    /// process-management-free.
    private var processes: [SlotKey: Process] = [:]

    /// 200KB cap on retained output per slot. Chatty builds stay bounded.
    private let bufferCap = 200_000

    init() {}

    // MARK: - Reads

    func list(serviceID: String) -> [String: TaskSlot] {
        queue.sync { slots[serviceID] ?? [:] }
    }

    // MARK: - Lifecycle

    /// Idempotent on (serviceID, name) and capped at `TaskLimits.maxRunningCommands`
    /// concurrent running commands per service. No-ops in either guard
    /// case — the UI is the authoritative cap enforcer; this is just
    /// defence-in-depth.
    func start(
        serviceID: String,
        name: String,
        command: String,
        cwd: URL,
        extraEnv: [String: String]
    ) {
        queue.sync {
            // Same-name double-start guard.
            if let current = slots[serviceID]?[name], current.state.isRunning {
                return
            }
            // Concurrency cap. Counts only currently-running slots, not
            // exited-but-pane-still-open ones.
            let runningNow = (slots[serviceID] ?? [:]).values
                .reduce(into: 0) { $0 += $1.state.isRunning ? 1 : 0 }
            if runningNow >= TaskLimits.maxRunningCommands {
                return
            }

            // Reset slot to a fresh running state. Anything left over from a
            // previous exited run is discarded.
            mutateLocked(serviceID, name) {
                $0 = TaskSlot(
                    state: .running(name: name, since: Date()),
                    buffer: ""
                )
            }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            let cwdEscaped = cwd.path.replacingOccurrences(of: "'", with: "'\\''")
            // `-i -l` so `.zshrc` loads (PATH for bun/nvm/etc. lives there
            // for most users). Re-export extraEnv *after* `.zshrc` to
            // preserve services.ts precedence over any `.zshrc` exports.
            let envPrefix = LifecycleSupervisor.shellExports(for: extraEnv)
            let wrapper = "\(envPrefix)cd '\(cwdEscaped)' && exec \(command)"
            process.arguments = ["-i", "-l", "-c", wrapper]
            // Color-env hints — same set as the app's TaskRunner and
            // LifecycleSupervisor. User extraEnv wins over inherited values.
            var env = ProcessInfo.processInfo.environment
            env["FORCE_COLOR"] = env["FORCE_COLOR"] ?? "1"
            env["CLICOLOR_FORCE"] = env["CLICOLOR_FORCE"] ?? "1"
            env["TERM"] = env["TERM"] ?? "xterm-256color"
            for (k, v) in extraEnv { env[k] = v }
            process.environment = env

            let outPipe = Pipe()
            let errPipe = Pipe()
            process.standardOutput = outPipe
            process.standardError = errPipe
            if let devNull = FileHandle(forReadingAtPath: "/dev/null") {
                process.standardInput = devNull
            }

            // Both pipes feed the same buffer — interleave matches what a
            // terminal would show.
            let onChunk: @Sendable (FileHandle) -> Void = { [weak self] h in
                let data = h.availableData
                if data.isEmpty { return }
                let text = String(data: data, encoding: .utf8) ?? ""
                self?.queue.async { [weak self] in
                    self?.appendLocked(serviceID: serviceID, name: name, text: text)
                }
            }
            outPipe.fileHandleForReading.readabilityHandler = onChunk
            errPipe.fileHandleForReading.readabilityHandler = onChunk

            process.terminationHandler = { [weak self] proc in
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                let code = proc.terminationStatus
                self?.queue.async { [weak self] in
                    self?.markExitedLocked(serviceID: serviceID, name: name, code: code)
                }
            }

            do {
                try process.run()
                processes[SlotKey(serviceID: serviceID, name: name)] = process
            } catch {
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                appendLocked(
                    serviceID: serviceID,
                    name: name,
                    text: "[matisa] failed to start: \(error)\n"
                )
                markExitedLocked(serviceID: serviceID, name: name, code: -1)
            }
        }
    }

    /// SIGTERM the running task, escalating to SIGKILL after a grace period.
    /// Signals the PID directly (`foreign: true`) — these tasks share the
    /// engine's process group, so `killpg` would also kill the engine.
    func cancel(serviceID: String, name: String) {
        let pid: pid_t? = queue.sync {
            guard
                let slot = slots[serviceID]?[name],
                case .running = slot.state,
                let proc = processes[SlotKey(serviceID: serviceID, name: name)]
            else { return nil }
            let pid = proc.processIdentifier
            return pid > 0 ? pid : nil
        }
        guard let pid else { return }
        Task.detached {
            await LifecycleSupervisor.stopWithEscalation(pid: pid, foreign: true)
        }
    }

    /// Wipe the buffer without stopping the process. No-op when no slot
    /// exists — we used to default a missing slot to `.idle + buffer:""`
    /// and write it back, which left ghost entries in the map for any
    /// service whose pane had ever been cleared.
    func clear(serviceID: String, name: String) {
        queue.sync {
            guard slots[serviceID]?[name] != nil else { return }
            mutateLocked(serviceID, name) { $0 = TaskSlot(state: $0.state, buffer: "") }
        }
    }

    /// Close the pane. No-op while the task is still running; on an exited
    /// slot, drops the entry entirely so subsequent `list(id)` calls return a
    /// map without this name.
    func closePane(serviceID: String, name: String) {
        queue.sync {
            guard let current = slots[serviceID]?[name] else { return }
            if case .running = current.state { return }
            var inner = slots[serviceID] ?? [:]
            inner.removeValue(forKey: name)
            if inner.isEmpty {
                slots.removeValue(forKey: serviceID)
            } else {
                slots[serviceID] = inner
            }
            // Drop the Process handle too if one's still lying around (after
            // a clean exit it'll be the just-finished one; harmless to release).
            processes.removeValue(forKey: SlotKey(serviceID: serviceID, name: name))
        }
    }

    // MARK: - Locked helpers (must be called from `queue`)

    private struct SlotKey: Hashable {
        let serviceID: String
        let name: String
    }

    private func mutateLocked(
        _ serviceID: String,
        _ name: String,
        _ block: (inout TaskSlot) -> Void
    ) {
        var inner = slots[serviceID] ?? [:]
        var s = inner[name] ?? TaskSlot(state: .idle, buffer: "")
        block(&s)
        inner[name] = s
        slots[serviceID] = inner
    }

    private func appendLocked(serviceID: String, name: String, text: String) {
        mutateLocked(serviceID, name) { s in
            var b = s.buffer + text
            if b.count > bufferCap {
                b = String(b.suffix(bufferCap))
            }
            s = TaskSlot(state: s.state, buffer: b)
        }
    }

    private func markExitedLocked(serviceID: String, name: String, code: Int32) {
        mutateLocked(serviceID, name) { s in
            if case .running(let n, let since) = s.state {
                s = TaskSlot(
                    state: .exited(name: n, code: code, since: since),
                    buffer: s.buffer
                )
            }
        }
        processes.removeValue(forKey: SlotKey(serviceID: serviceID, name: name))
    }
}
