import Foundation
import Darwin
import MatisaCore

/// Engine-side ad-hoc task runner. Owns the per-(serviceID, kind) slot map
/// for build / script invocations. Port of the app's `TaskRunner`; semantics
/// are identical:
///
///   - At most one task per (serviceID, kind). A second `start` of the same
///     shape while one is already running is silently dropped.
///   - Stdout + stderr are interleaved into a single in-memory buffer, capped
///     at `bufferCap` bytes (the oldest are dropped on overflow).
///   - On exit, the slot transitions `running(name, since) → exited(name,
///     code, since)`. The buffer is retained until `closePane` (or the next
///     `start` for that slot).
///   - `cancel` SIGTERMs the child directly (these tasks share the engine's
///     process group, so `killpg` would also kill the engine), escalating to
///     SIGKILL via `LifecycleSupervisor.stopWithEscalation`.
///
/// Marked `@unchecked Sendable`: a serial `DispatchQueue` (`engine.tasks`)
/// guards all mutable state — the `slots` map plus the running `Process`
/// handles. `Process` pipe callbacks (`readabilityHandler`, `terminationHandler`)
/// arrive on Foundation worker threads and marshal back onto the queue
/// before touching any state.
final class TaskService: @unchecked Sendable {

    private let queue = DispatchQueue(label: "engine.tasks")

    /// Outer key is service id; inner key is the task kind. Mirrors the
    /// `TaskList` wire shape exactly.
    private var slots: [String: [TaskKind: TaskSlot]] = [:]

    /// Live Process handles, keyed by (serviceID, kind). Kept separate from
    /// the wire-visible `slots` map so the wire type can stay
    /// process-management-free.
    private var processes: [SlotKey: Process] = [:]

    /// 200KB cap on retained output per slot. Matches the app's `TaskRunner`
    /// — chatty builds stay bounded.
    private let bufferCap = 200_000

    init() {}

    // MARK: - Reads

    func list(serviceID: String) -> [TaskKind: TaskSlot] {
        queue.sync { slots[serviceID] ?? [:] }
    }

    // MARK: - Lifecycle

    /// Idempotent. No-op when a task of the same kind is already running for
    /// this service id.
    func start(
        serviceID: String,
        kind: TaskKind,
        name: String,
        command: String,
        cwd: URL,
        extraEnv: [String: String]
    ) {
        queue.sync {
            // Same-shape double-start guard. Mirrors `TaskRunner.start`.
            if let current = slots[serviceID]?[kind], current.state.isRunning {
                return
            }
            // Reset slot to a fresh running state. Anything left over from a
            // previous exited run is discarded.
            mutateLocked(serviceID, kind) {
                $0 = TaskSlot(
                    state: .running(name: name, since: Date()),
                    buffer: ""
                )
            }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            let cwdEscaped = cwd.path.replacingOccurrences(of: "'", with: "'\\''")
            let wrapper = "cd '\(cwdEscaped)' && exec \(command)"
            process.arguments = ["-l", "-c", wrapper]
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
                    self?.appendLocked(serviceID: serviceID, kind: kind, text: text)
                }
            }
            outPipe.fileHandleForReading.readabilityHandler = onChunk
            errPipe.fileHandleForReading.readabilityHandler = onChunk

            process.terminationHandler = { [weak self] proc in
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                let code = proc.terminationStatus
                self?.queue.async { [weak self] in
                    self?.markExitedLocked(serviceID: serviceID, kind: kind, code: code)
                }
            }

            do {
                try process.run()
                processes[SlotKey(serviceID: serviceID, kind: kind)] = process
            } catch {
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                appendLocked(
                    serviceID: serviceID,
                    kind: kind,
                    text: "[matisa] failed to start: \(error)\n"
                )
                markExitedLocked(serviceID: serviceID, kind: kind, code: -1)
            }
        }
    }

    /// SIGTERM the running task, escalating to SIGKILL after a grace period.
    /// Signals the PID directly (`foreign: true`) — these tasks share the
    /// engine's process group, so `killpg` would also kill the engine.
    func cancel(serviceID: String, kind: TaskKind) {
        let pid: pid_t? = queue.sync {
            guard
                let slot = slots[serviceID]?[kind],
                case .running = slot.state,
                let proc = processes[SlotKey(serviceID: serviceID, kind: kind)]
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
    func clear(serviceID: String, kind: TaskKind) {
        queue.sync {
            guard slots[serviceID]?[kind] != nil else { return }
            mutateLocked(serviceID, kind) { $0 = TaskSlot(state: $0.state, buffer: "") }
        }
    }

    /// Close the pane. No-op while the task is still running; on an exited
    /// slot, drops the entry entirely so subsequent `list(id)` calls return a
    /// map without this kind. Diverges slightly from the app's pre-2e.3
    /// `TaskRunner.closePane`, which transitions the slot to `.idle` with an
    /// empty buffer — equivalent over the wire because the app's
    /// `replaceSlotsFromEngine` treats absent and `.idle` the same way
    /// (`isPaneVisible` returns false for both), and an absent entry keeps
    /// the `tasks.list` payload small.
    func closePane(serviceID: String, kind: TaskKind) {
        queue.sync {
            guard let current = slots[serviceID]?[kind] else { return }
            if case .running = current.state { return }
            var inner = slots[serviceID] ?? [:]
            inner.removeValue(forKey: kind)
            if inner.isEmpty {
                slots.removeValue(forKey: serviceID)
            } else {
                slots[serviceID] = inner
            }
            // Drop the Process handle too if one's still lying around (after
            // a clean exit it'll be the just-finished one; harmless to release).
            processes.removeValue(forKey: SlotKey(serviceID: serviceID, kind: kind))
        }
    }

    // MARK: - Locked helpers (must be called from `queue`)

    private struct SlotKey: Hashable {
        let serviceID: String
        let kind: TaskKind
    }

    private func mutateLocked(
        _ serviceID: String,
        _ kind: TaskKind,
        _ block: (inout TaskSlot) -> Void
    ) {
        var inner = slots[serviceID] ?? [:]
        var s = inner[kind] ?? TaskSlot(state: .idle, buffer: "")
        block(&s)
        inner[kind] = s
        slots[serviceID] = inner
    }

    private func appendLocked(serviceID: String, kind: TaskKind, text: String) {
        mutateLocked(serviceID, kind) { s in
            var b = s.buffer + text
            if b.count > bufferCap {
                b = String(b.suffix(bufferCap))
            }
            s = TaskSlot(state: s.state, buffer: b)
        }
    }

    private func markExitedLocked(serviceID: String, kind: TaskKind, code: Int32) {
        mutateLocked(serviceID, kind) { s in
            if case .running(let name, let since) = s.state {
                s = TaskSlot(
                    state: .exited(name: name, code: code, since: since),
                    buffer: s.buffer
                )
            }
        }
        processes.removeValue(forKey: SlotKey(serviceID: serviceID, kind: kind))
    }
}
