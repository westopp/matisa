import Foundation
import MatisaCore

enum Lsof {
    /// Run `lsof -iTCP -sTCP:LISTEN -nP -F pcn` and parse the result.
    /// The shape and parsing live in MatisaCore so the engine can use the
    /// same code; this remains the app's async wrapper around it.
    static func listening() async throws -> [ListeningPort] {
        let output = try await Shell.runCapturing(
            executable: "/usr/sbin/lsof",
            arguments: ["-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn"]
        )
        return LsofParser.parse(output)
    }

    /// Re-export of the MatisaCore parser so the existing test still finds it.
    /// Will go away once the test moves to MatisaCoreTests.
    static func parse(_ raw: String) -> [ListeningPort] {
        LsofParser.parse(raw)
    }

    static func portFromAddress(_ address: String) -> Int? {
        LsofParser.portFromAddress(address)
    }
}

/// Heuristics for spotting unmanaged dev processes among listening ports.
enum UnmanagedHeuristics {
    /// Process names that look like dev servers.
    static let devCommands: Set<String> = [
        "node", "bun", "deno", "vite", "next-server",
        "python", "python3", "ruby", "rails",
        "cargo", "go", "air",
        "java", "elixir", "iex", "mix",
        "php", "rake"
    ]

    /// Port ranges considered "dev-y" — the user's PORTS.md range plus the
    /// common framework defaults explicitly avoided in the registry.
    static let devPortRanges: [ClosedRange<Int>] = [
        3000...3099,
        4000...4321,
        4200...4200,
        5173...5180,
        5400...5499,
        5555...5555,
        6006...6006,
        8000...8090,
        8888...8888,
        9000...9229
    ]

    static func looksLikeDevServer(_ port: ListeningPort) -> Bool {
        let cmd = port.command.lowercased()
        let nameMatch = devCommands.contains(where: { cmd.contains($0) })
        let portMatch = devPortRanges.contains(where: { $0.contains(port.port) })
        return nameMatch || portMatch
    }
}
