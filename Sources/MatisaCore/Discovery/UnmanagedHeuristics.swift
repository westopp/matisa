import Foundation

/// Heuristics for spotting unmanaged dev processes among listening ports.
/// Shared between the engine (during `services.snapshot` merge) and the app's
/// local fallback path.
public enum UnmanagedHeuristics {
    /// Process names that look like dev servers.
    public static let devCommands: Set<String> = [
        "node", "bun", "deno", "vite", "next-server",
        "python", "python3", "ruby", "rails",
        "cargo", "go", "air",
        "java", "elixir", "iex", "mix",
        "php", "rake"
    ]

    /// Port ranges considered "dev-y" — the user's PORTS.md range plus the
    /// common framework defaults explicitly avoided in the registry.
    public static let devPortRanges: [ClosedRange<Int>] = [
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

    public static func looksLikeDevServer(_ port: ListeningPort) -> Bool {
        let cmd = port.command.lowercased()
        let nameMatch = devCommands.contains(where: { cmd.contains($0) })
        let portMatch = devPortRanges.contains(where: { $0.contains(port.port) })
        return nameMatch || portMatch
    }
}
