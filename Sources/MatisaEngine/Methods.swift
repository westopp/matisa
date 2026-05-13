import Foundation

// Response shapes for the methods exposed in phase 0 / phase 1.
// These will move into a shared schema module once the CLI/MCP/widget
// clients show up — for now they live next to the engine that emits them.

struct EngineStatus: Encodable {
    let status: String          // "ok"
    let version: String
    let uptimeSeconds: Int
}

/// Empty placeholder until phase 2b moves discovery into the engine. Once
/// `services.list` returns real data, this shape will mirror the merged
/// spec + state structure that the app currently builds in `ServiceStore`.
struct ServiceList: Encodable {
    let services: [Service]
    struct Service: Encodable {} // intentionally empty until 2b
}
