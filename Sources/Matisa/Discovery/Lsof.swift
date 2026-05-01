import Foundation

/// One listening socket discovered by `lsof`.
struct ListeningPort: Hashable, Sendable {
    let pid: Int32
    let command: String      // process name as lsof reports it
    let address: String      // raw address string e.g. "*:5478", "127.0.0.1:5478", "[::1]:5478"
    let port: Int

    var isLocalhost: Bool {
        address.hasPrefix("127.") || address.hasPrefix("[::1]") || address.hasPrefix("*")
    }
}

enum Lsof {
    /// Run `lsof -iTCP -sTCP:LISTEN -nP -F pcn` and parse the result.
    static func listening() async throws -> [ListeningPort] {
        let output = try await Shell.runCapturing(
            executable: "/usr/sbin/lsof",
            arguments: ["-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn"]
        )
        return parse(output)
    }

    /// Parse `-F pcn`-formatted lsof output. Each process record is a `p<pid>`
    /// line, optionally a `c<command>` line, and one or more `n<addr:port>` lines.
    static func parse(_ raw: String) -> [ListeningPort] {
        var results: [ListeningPort] = []

        var currentPID: Int32?
        var currentCmd: String = ""

        for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let first = line.first else { continue }
            let body = String(line.dropFirst())

            switch first {
            case "p":
                currentPID = Int32(body)
                currentCmd = ""
            case "c":
                currentCmd = body
            case "n":
                guard let pid = currentPID else { continue }
                guard let port = portFromAddress(body) else { continue }
                results.append(ListeningPort(
                    pid: pid,
                    command: currentCmd,
                    address: body,
                    port: port
                ))
            default:
                continue
            }
        }
        return results
    }

    /// Extract the trailing port number from addresses like `*:5478`,
    /// `127.0.0.1:5478`, or `[::1]:5478`.
    static func portFromAddress(_ address: String) -> Int? {
        guard let colonIdx = address.lastIndex(of: ":") else { return nil }
        let portPart = address[address.index(after: colonIdx)...]
        return Int(portPart)
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
