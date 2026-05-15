import Foundation

/// Wire types for the engine's ad-hoc command surface (per-service named
/// commands — builds, tests, lints, anything the user wires up). Mirrors
/// the shape the app's `TaskRunner` exposes to its SwiftUI bindings, minus
/// engine-internal process-management state (PID, Process handles).
///
/// The app polls `tasks.list(id)` for services with a visible command pane
/// and mirrors the result into its local `TaskRunner` so the existing UI
/// bindings keep working.

/// Tunables for the ad-hoc commands surface. Centralised here so engine,
/// app, and UI all reference the same numbers.
public enum TaskLimits {
    /// Per-service hard cap on concurrently running ad-hoc commands. The
    /// supervised long-running `command:` (the dev server) does not count
    /// toward this — it has its own start/stop on the row. So the effective
    /// per-service cap is `1 supervised + maxRunningCommands` ad-hoc.
    ///
    /// Set to 2 for the MVP to bound system-resource impact. When this is
    /// at or above the user's appetite, the menu disables further command
    /// entries until something stops.
    public static let maxRunningCommands: Int = 2
}

/// Lifecycle state of a single command slot.
///
/// `idle` means the pane is closed and there's no buffer. `running` means a
/// command is in flight; the engine streams stdout/stderr into the slot
/// buffer. `exited` means the last run completed (cleanly or not) and the
/// buffer is retained until the user closes the pane.
public enum TaskState: Hashable, Sendable {
    case idle
    case running(name: String, since: Date)
    case exited(name: String, code: Int32, since: Date)

    public var isRunning: Bool { if case .running = self { true } else { false } }
}

extension TaskState: Codable {
    private enum Tag: String, Codable {
        case idle, running, exited
    }
    private enum CodingKeys: String, CodingKey {
        case type, name, code, since
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .idle:
            try c.encode(Tag.idle, forKey: .type)
        case .running(let name, let since):
            try c.encode(Tag.running, forKey: .type)
            try c.encode(name, forKey: .name)
            try c.encode(since, forKey: .since)
        case .exited(let name, let code, let since):
            try c.encode(Tag.exited, forKey: .type)
            try c.encode(name, forKey: .name)
            try c.encode(code, forKey: .code)
            try c.encode(since, forKey: .since)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Tag.self, forKey: .type) {
        case .idle:
            self = .idle
        case .running:
            self = .running(
                name: try c.decode(String.self, forKey: .name),
                since: try c.decode(Date.self, forKey: .since)
            )
        case .exited:
            self = .exited(
                name: try c.decode(String.self, forKey: .name),
                code: try c.decode(Int32.self, forKey: .code),
                since: try c.decode(Date.self, forKey: .since)
            )
        }
    }
}

/// Observability-only slot snapshot. Carries the current lifecycle state and
/// the buffered stdout+stderr (interleaved, capped at ~200KB on the engine
/// side). No process handle or PID — the engine owns those internally; the
/// app cancels via `tasks.cancel` RPC, not by pid.
public struct TaskSlot: Hashable, Sendable, Codable {
    public let state: TaskState
    public let buffer: String

    public init(state: TaskState, buffer: String) {
        self.state = state
        self.buffer = buffer
    }
}

/// Wire shape for `tasks.list`. Wraps a command-name→slot map so the
/// JSON-RPC `result` is always an object. JSON shape is
/// `{"<command-name>": {state, buffer}, ...}` — the map is just a
/// string-keyed dictionary, so Foundation encodes it as a plain JSON
/// object directly.
///
/// Slots are keyed by **command name** (the user-visible label from the
/// config's `commands:` block), not by an enum tag. Matisa used to split
/// build vs script into distinct slot kinds; that distinction was dropped
/// when builds were folded into the unified commands surface.
public struct TaskList: Codable, Sendable {
    public let slots: [String: TaskSlot]

    public init(slots: [String: TaskSlot]) {
        self.slots = slots
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(slots)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        self.slots = try c.decode([String: TaskSlot].self)
    }

    /// Number of slots currently in the running state. The engine uses this
    /// (plus `maxRunningCommands`) to decide whether to accept a new start.
    public var runningCount: Int {
        slots.values.reduce(into: 0) { count, slot in
            if slot.state.isRunning { count += 1 }
        }
    }
}
