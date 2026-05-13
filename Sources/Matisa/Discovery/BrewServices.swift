import Foundation
import MatisaCore

enum BrewServices {
    static var brewPath: String {
        Shell.which("brew") ?? "/opt/homebrew/bin/brew"
    }

    static func list() async -> [BrewService] {
        guard let output = try? await Shell.runCapturing(
            executable: brewPath,
            arguments: ["services", "list", "--json"]
        ) else { return [] }
        return BrewJSONParser.parse(output)
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
