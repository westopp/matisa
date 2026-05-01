import Foundation

struct BrewService: Hashable, Sendable {
    let name: String
    let status: String  // "started", "stopped", "error"
    let user: String
    let plist: String

    var isRunning: Bool { status.lowercased() == "started" }
}

enum BrewServices {
    static var brewPath: String {
        Shell.which("brew") ?? "/opt/homebrew/bin/brew"
    }

    static func list() async -> [BrewService] {
        guard let output = try? await Shell.runCapturing(
            executable: brewPath,
            arguments: ["services", "list", "--json"]
        ) else { return [] }
        return parse(output)
    }

    static func parse(_ raw: String) -> [BrewService] {
        guard let data = raw.data(using: .utf8) else { return [] }
        guard let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return arr.map { dict in
            BrewService(
                name: (dict["name"] as? String) ?? "",
                status: (dict["status"] as? String) ?? "",
                user: (dict["user"] as? String) ?? "",
                plist: (dict["file"] as? String) ?? ""
            )
        }
    }

    static func find(_ name: String) async -> BrewService? {
        await list().first(where: { $0.name == name })
    }

    static func start(_ name: String) async throws {
        try await Shell.run(executable: brewPath, arguments: ["services", "start", name])
    }

    static func stop(_ name: String) async throws {
        try await Shell.run(executable: brewPath, arguments: ["services", "stop", name])
    }

    static func restart(_ name: String) async throws {
        try await Shell.run(executable: brewPath, arguments: ["services", "restart", name])
    }
}
