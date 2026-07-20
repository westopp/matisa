import Foundation
import MatisaCore

/// Tiny formatting layer between command handlers and stdout. Two modes —
/// human-readable (default) and `--json` (pretty-printed JSON of the
/// engine's raw `result`). Anything that crosses these helpers must be
/// safe to print untrusted (no ANSI escapes injected from engine
/// responses without a sanitisation pass; today we just print verbatim
/// because the only fields the engine sends are short identifiers).
enum Output {

    /// Print to stdout with a trailing newline.
    static func println(_ s: String) {
        FileHandle.standardOutput.write(Data("\(s)\n".utf8))
    }

    /// Print pre-encoded JSON bytes (the raw `result` field from a JSON-RPC
    /// response, re-pretty-printed for human-friendly `--json` output).
    static func printJSON(_ raw: Data) throws {
        let obj = try JSONSerialization.jsonObject(with: raw, options: [.fragmentsAllowed])
        let pretty = try JSONSerialization.data(
            withJSONObject: obj,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        FileHandle.standardOutput.write(pretty)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    // MARK: - services.snapshot rendering

    /// Render a `ServicesSnapshot` as a fixed-column table. Columns:
    ///   ID    KIND    STATE    PORT    PID    NAME
    /// Width is bounded by the longest field per column (no truncation —
    /// the IDs are already short by construction).
    ///
    /// Output is grouped: managed services first, then unmanaged. A blank
    /// line separates the groups when both are present. Empty snapshots
    /// produce a single explanatory line so the user isn't staring at a
    /// blank terminal.
    static func renderServicesTable(_ snap: ServicesSnapshot) {
        let total = snap.managed.count + snap.unmanaged.count
        if total == 0 {
            println("No services. Add some in matisa.config.ts.")
            return
        }

        var rows: [[String]] = [
            ["ID", "KIND", "STATE", "PORT", "PID", "NAME"]
        ]
        for svc in snap.managed {
            rows.append(row(for: svc))
        }
        if !snap.unmanaged.isEmpty {
            // Separator row is rendered as a blank line in printTable.
            rows.append([])
            for svc in snap.unmanaged {
                rows.append(row(for: svc))
            }
        }

        printTable(rows: rows)

        // Footer with Docker daemon state — useful at a glance, especially
        // when "Stopped" rows are mysterious because the daemon's down.
        let daemon = snap.dockerDaemonRunning ? "running" : "stopped"
        println("")
        println("Docker daemon: \(daemon)")
    }

    private static func row(for svc: Service) -> [String] {
        let ports = svc.spec.exposedPorts.map { String($0.port) }.joined(separator: ",")
        let pid = svc.state.pid.map { String($0) } ?? "-"
        return [
            svc.id,
            svc.kind.rawValue,
            svc.state.label,
            ports.isEmpty ? "-" : ports,
            pid,
            svc.spec.name,
        ]
    }

    /// Two-space gutter between columns, left-aligned, padded to the
    /// per-column max width. Empty rows render as a single blank line.
    private static func printTable(rows: [[String]]) {
        // Compute per-column widths from non-empty rows.
        let widths: [Int] = {
            var ws: [Int] = []
            for row in rows where !row.isEmpty {
                for (i, cell) in row.enumerated() {
                    if i >= ws.count { ws.append(cell.count) }
                    else if cell.count > ws[i] { ws[i] = cell.count }
                }
            }
            return ws
        }()

        for row in rows {
            if row.isEmpty {
                println("")
                continue
            }
            var parts: [String] = []
            for (i, cell) in row.enumerated() {
                let w = i < widths.count ? widths[i] : cell.count
                if i == row.count - 1 {
                    parts.append(cell) // no trailing pad on last column
                } else {
                    parts.append(cell.padding(toLength: w, withPad: " ", startingAt: 0))
                }
            }
            println(parts.joined(separator: "  "))
        }
    }

    // MARK: - engine.status rendering

    static func renderEngineStatus(_ info: EngineStatusInfo) {
        println("status:  \(info.status)")
        println("version: \(info.version)")
        println("uptime:  \(formatUptime(info.uptimeSeconds))")
    }

    private static func formatUptime(_ seconds: Int) -> String {
        // Decompose into days/hours/minutes/seconds, hide leading zero units.
        let d = seconds / 86400
        let h = (seconds % 86400) / 3600
        let m = (seconds % 3600) / 60
        let s = seconds % 60
        var parts: [String] = []
        if d > 0 { parts.append("\(d)d") }
        if h > 0 || !parts.isEmpty { parts.append("\(h)h") }
        if m > 0 || !parts.isEmpty { parts.append("\(m)m") }
        parts.append("\(s)s")
        return parts.joined(separator: " ")
    }
}
