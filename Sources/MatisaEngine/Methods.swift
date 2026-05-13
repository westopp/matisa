import Foundation

// Response shapes for the methods exposed in phase 0 / phase 1.
// These will move into a shared schema module once the CLI/MCP/widget
// clients show up — for now they live next to the engine that emits them.

struct EngineStatus: Encodable {
    let status: String          // "ok"
    let version: String
    let uptimeSeconds: Int
}

struct ProjectList: Encodable {
    struct Project: Encodable {
        let id: String
        let name: String
        let group: String
        let status: String      // "running" | "stopped" — full enum lands in phase 3
    }
    let projects: [Project]
}
