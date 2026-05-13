import Foundation

/// Pure-data parsers for the output of `lsof`, `docker ps`, `docker compose
/// ls`, and `brew services list`. Lifted out of the original app-side enums
/// so the engine can reuse the same parsing logic — both sides produce the
/// exact same `ListeningPort` / `DockerContainer` / etc. for the same input.
///
/// No I/O. Tested by `MatisaCoreTests` and (legacy) `LsofParserTests`.

public enum LsofParser {
    /// Parse `-F pcn`-formatted lsof output. Each process record is a `p<pid>`
    /// line, optionally a `c<command>` line, and one or more `n<addr:port>` lines.
    public static func parse(_ raw: String) -> [ListeningPort] {
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
    public static func portFromAddress(_ address: String) -> Int? {
        guard let colonIdx = address.lastIndex(of: ":") else { return nil }
        let portPart = address[address.index(after: colonIdx)...]
        return Int(portPart)
    }
}

public enum DockerJSONParser {
    /// `docker ps -a --format '{{json .}}'` produces one JSON object per line.
    public static func parseContainers(_ raw: String) -> [DockerContainer] {
        raw.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line in
            guard let data = String(line).data(using: .utf8) else { return nil }
            guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return DockerContainer(
                id: (dict["ID"] as? String) ?? "",
                name: (dict["Names"] as? String) ?? "",
                image: (dict["Image"] as? String) ?? "",
                state: ((dict["State"] as? String) ?? "").lowercased(),
                status: (dict["Status"] as? String) ?? "",
                ports: (dict["Ports"] as? String) ?? ""
            )
        }
    }

    /// `docker compose ls --all --format json` produces a single JSON array.
    public static func parseComposeStacks(_ raw: String) -> [DockerComposeStack] {
        guard let data = raw.data(using: .utf8) else { return [] }
        guard let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return arr.map { dict in
            DockerComposeStack(
                name: (dict["Name"] as? String) ?? "",
                status: (dict["Status"] as? String) ?? "",
                configFiles: (dict["ConfigFiles"] as? String) ?? ""
            )
        }
    }
}

public enum BrewJSONParser {
    /// `brew services list --json` produces a single JSON array.
    public static func parse(_ raw: String) -> [BrewService] {
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
}
