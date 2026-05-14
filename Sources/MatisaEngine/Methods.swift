import Foundation
import MatisaCore

// Response shapes for engine RPC methods. Most wire types live in MatisaCore
// so the app's client code shares the exact same Codable definitions; the
// engine-only shapes (e.g. EngineStatus, which has no app-side mirror yet)
// stay here.

/// Mirrored on the app side as `EngineStatusInfo` in
/// `Sources/Matisa/Engine/EngineClient.swift`. Rename or add fields on both
/// sides together — there's no compile-time link between them.
struct EngineStatus: Encodable {
    let status: String          // "ok"
    let version: String
    let uptimeSeconds: Int
}

/// Lifecycle RPCs that act on a single service take this shape. Engine-only:
/// clients encode the equivalent `{"id": "..."}` directly. Kept as a simple
/// struct so the dispatcher's typed-params overload can decode it.
struct ServiceIDParams: Decodable {
    let id: String
}

/// Params for the lifecycle RPCs that (re)spawn the service — `services.start`,
/// `services.restart`, `services.take_over`. Carries the globally-selected env
/// context name so the engine resolves project env as `base + contexts[name]`
/// rather than `base` only. Stop/kill/pull stay on `ServiceIDParams` since
/// they don't spawn. `activeEnvContext` is optional so old clients that send
/// `{"id": "..."}` still decode (engine then falls back to its injected
/// resolver, which in production is `{ nil }` — same pre-fix behaviour).
struct ServiceLifecycleParams: Decodable {
    let id: String
    let activeEnvContext: String?
}

/// Params for `tasks.start`. The engine resolves the command in the
/// caller-supplied `cwd` via `/bin/zsh -l -c "cd <cwd> && exec <command>"`;
/// `extraEnv` overrides values inherited from the engine's environment.
/// `cwd` is a `URL` because `Foundation.URL`'s default Codable serializes as
/// a plain JSON string scalar, same shape `Service.logsPath` and
/// `PersistedSpawn.logPath` already ride over the wire.
struct TaskStartParams: Decodable {
    let id: String
    let kind: TaskKind
    let name: String
    let command: String
    let cwd: URL
    let extraEnv: [String: String]
}

/// Params for `tasks.cancel`, `tasks.clear`, and `tasks.close_pane` — all of
/// which act on a single (serviceID, kind) slot.
struct TaskCancelParams: Decodable {
    let id: String
    let kind: TaskKind
}

/// `{}` — for lifecycle methods whose success is signalled by the absence of
/// an error. Clients poll `services.snapshot` for the new state. JSON-RPC
/// success replies must include a `result` field, so this is preferable to
/// returning Void.
struct EmptyResponse: Encodable {}
