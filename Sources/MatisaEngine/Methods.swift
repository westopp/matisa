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
