import Foundation

// Response shapes for engine RPC methods. Most wire types live in MatisaCore
// so the app's client code shares the exact same Codable definitions; the
// engine-only shapes (e.g. EngineStatus, which has no app-side mirror yet)
// stay here.

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

/// `{}` — for lifecycle methods whose success is signalled by the absence of
/// an error. Clients poll `services.snapshot` for the new state. JSON-RPC
/// success replies must include a `result` field, so this is preferable to
/// returning Void.
struct EmptyResponse: Encodable {}
