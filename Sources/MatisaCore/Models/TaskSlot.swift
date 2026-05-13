import Foundation

/// Wire types for the engine's ad-hoc task surface (per-service build /
/// script invocations). Mirrors the shape the app's `TaskRunner` exposes to
/// its SwiftUI bindings, minus engine-internal process-management state
/// (PID, Process handles). The app polls `tasks.list(id)` for services with
/// a visible task pane and mirrors the result into its local `TaskRunner` so
/// the existing UI bindings keep working.

/// Which kind of ad-hoc task this is. At most one task per (serviceID, kind)
/// can run at a time. `build` is the configured `build` command (single or
/// the user-picked named entry from a `multi` build); `script` is one of the
/// `scripts` entries.
public enum TaskKind: String, Codable, Sendable {
    case build, script
}

/// Lifecycle state of a single task slot.
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
/// app cancels tasks via `tasks.cancel` RPC, not by pid.
public struct TaskSlot: Hashable, Sendable, Codable {
    public let state: TaskState
    public let buffer: String

    public init(state: TaskState, buffer: String) {
        self.state = state
        self.buffer = buffer
    }
}

/// Wire shape for `tasks.list`. Wraps the kind→slot map so the JSON-RPC
/// `result` is always an object. JSON shape is `{"build": {...}, "script":
/// {...}}` — Foundation's `Dictionary<E, V> where E: RawRepresentable<String>`
/// encodes as an unkeyed container of alternating key/value pairs, so we
/// transcode via the string raw values manually to get a proper JSON object.
public struct TaskList: Codable, Sendable {
    public let slots: [TaskKind: TaskSlot]

    public init(slots: [TaskKind: TaskSlot]) {
        self.slots = slots
    }

    public func encode(to encoder: Encoder) throws {
        let stringKeyed: [String: TaskSlot] = Dictionary(
            uniqueKeysWithValues: slots.map { ($0.key.rawValue, $0.value) }
        )
        var c = encoder.singleValueContainer()
        try c.encode(stringKeyed)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        let stringKeyed = try c.decode([String: TaskSlot].self)
        var typed: [TaskKind: TaskSlot] = [:]
        for (k, v) in stringKeyed {
            guard let kind = TaskKind(rawValue: k) else {
                // Unknown kinds are dropped silently — forward-compat in case
                // the engine grows a new TaskKind variant the app doesn't know
                // about yet. A stricter decoder would throw; the app's UI
                // would surface a useless "decode failed" instead.
                continue
            }
            typed[kind] = v
        }
        self.slots = typed
    }
}
