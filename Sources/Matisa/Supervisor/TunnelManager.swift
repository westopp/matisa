import Foundation
import Observation

/// Manages one in-process `Foundation.Process` per active public tunnel
/// (sish over SSH). Streams stderr/stdout via Pipes so we can extract the
/// assigned hostname from sish's banner and surface it to the UI within
/// seconds of connecting.
///
/// Lifetime is tied to the running app — when Matisa quits, all tunnels go
/// with it. That's intentional: sish hands us a new random subdomain on
/// each reconnect, so any "auto-resume across restarts" behaviour would
/// silently break links the user had already shared.
@MainActor
@Observable
final class TunnelManager {
    private(set) var statuses: [String: PublicTunnelStatus] = [:]

    /// Outputs collected so far per service id, to aid debugging via the
    /// detail-pane error string when the SSH process exits early.
    private var processes: [String: Process] = [:]
    private var buffers: [String: String] = [:]

    func status(for serviceID: String) -> PublicTunnelStatus {
        statuses[serviceID] ?? .idle
    }

    /// Whether the configured SSH key file exists on disk. The Share menu
    /// uses this to disable the public-tunnel item when the key is missing.
    static func sshKeyExists(_ tunnel: TunnelConfig) -> Bool {
        FileManager.default.fileExists(atPath: tunnel.sshKeyPath.path)
    }

    /// Start an SSH reverse tunnel for the given service. `hostHeader` is the
    /// service's Caddy URL (e.g. `myapp.localhost`); when set, we forward to
    /// `localhost:80` and ask sish to rewrite the Host header so Caddy routes
    /// the request correctly. With no `hostHeader`, we forward straight to
    /// `localhost:<port>` (plain dev server, no Caddy in the loop).
    func start(
        serviceID: String,
        port: Int,
        hostHeader: String?,
        tunnel: TunnelConfig
    ) {
        if statuses[serviceID]?.isActive == true { return }

        guard let sshPath = Shell.which("ssh") else {
            statuses[serviceID] = .error("ssh not found in PATH")
            return
        }
        guard Self.sshKeyExists(tunnel) else {
            statuses[serviceID] = .error("ssh key not found at \(tunnel.sshKeyPath.path)")
            return
        }

        statuses[serviceID] = .connecting
        buffers[serviceID] = ""

        let target: String
        var trailing: [String] = []
        if let hostHeader, !hostHeader.isEmpty {
            target = "\(hostHeader):80"
            trailing = ["host-header=\(hostHeader)"]
        } else {
            target = "localhost:\(port)"
        }

        let args: [String] = [
            "-i", tunnel.sshKeyPath.path,
            "-p", String(tunnel.port),
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes",
            "-T",
            "-R", "any:80:\(target)",
            "\(tunnel.user)@\(tunnel.server)"
        ] + trailing

        let process = Process()
        process.executableURL = URL(fileURLWithPath: sshPath)
        process.arguments = args

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        if let devNull = FileHandle(forReadingAtPath: "/dev/null") {
            process.standardInput = devNull
        }

        let onChunk: @Sendable (FileHandle) -> Void = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { return }
            let text = String(data: data, encoding: .utf8) ?? ""
            Task { @MainActor [weak self] in
                self?.ingest(serviceID: serviceID, chunk: text)
            }
        }
        outPipe.fileHandleForReading.readabilityHandler = onChunk
        errPipe.fileHandleForReading.readabilityHandler = onChunk

        process.terminationHandler = { [weak self] proc in
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            let code = proc.terminationStatus
            Task { @MainActor [weak self] in
                self?.markExited(serviceID: serviceID, code: code)
            }
        }

        do {
            try process.run()
            processes[serviceID] = process
        } catch {
            statuses[serviceID] = .error("failed to spawn ssh: \(error)")
            processes.removeValue(forKey: serviceID)
        }
    }

    /// SIGTERM the SSH process for this service. No-op if not running.
    func stop(serviceID: String) {
        if let process = processes.removeValue(forKey: serviceID) {
            if process.isRunning {
                process.terminate()
            }
        }
        buffers.removeValue(forKey: serviceID)
        statuses[serviceID] = .idle
    }

    /// Same as `stop` but leaves an explanatory status (used when the upstream
    /// service has been stopped — the tunnel is meaningless without a backend).
    func stopBecauseServiceStopped(serviceID: String) {
        if let process = processes.removeValue(forKey: serviceID) {
            if process.isRunning {
                process.terminate()
            }
        }
        buffers.removeValue(forKey: serviceID)
        statuses[serviceID] = .idle
    }

    func clearError(serviceID: String) {
        if case .error = statuses[serviceID] {
            statuses[serviceID] = .idle
        }
    }

    // MARK: - Internal

    private func ingest(serviceID: String, chunk: String) {
        let stripped = AnsiStripping.strip(chunk)
        var buf = (buffers[serviceID] ?? "") + stripped
        // Cap to keep memory bounded — sish banners are tiny but a long-running
        // tunnel can still accumulate connection logs over time.
        if buf.count > 16_000 { buf = String(buf.suffix(16_000)) }
        buffers[serviceID] = buf

        // Only look for the URL while we're still waiting for it; once .live,
        // skip the regex on every chunk.
        if case .connecting = statuses[serviceID] ?? .idle, let host = Self.extractHost(buf) {
            statuses[serviceID] = .live(url: "https://\(host)")
        }
    }

    private func markExited(serviceID: String, code: Int32) {
        processes.removeValue(forKey: serviceID)
        let buf = buffers[serviceID] ?? ""
        buffers.removeValue(forKey: serviceID)
        switch statuses[serviceID] ?? .idle {
        case .idle:
            // Stop was requested, nothing to report.
            break
        default:
            if code == 0 {
                statuses[serviceID] = .disconnected
            } else {
                let msg = Self.summariseFailure(buf: buf, code: code)
                statuses[serviceID] = .error(msg)
            }
        }
    }

    /// Pull the HTTP host out of a sish banner. sish prints lines like
    /// `HTTP: http://abcd1234.tunnel.westopp.com` (with optional ANSI colour
    /// codes around it). We strip ANSI before this runs.
    static func extractHost(_ text: String) -> String? {
        // Strict: look for the literal "HTTP:" label first, then fall back to
        // any http://<host> we can find. The label is what sish actually emits.
        if let labelRange = text.range(of: #"HTTP:\s*https?://([^\s]+)"#, options: .regularExpression) {
            let match = text[labelRange]
            if let urlRange = match.range(of: #"https?://([^\s]+)"#, options: .regularExpression) {
                let urlStr = match[urlRange]
                return String(urlStr.dropFirst(urlStr.hasPrefix("https://") ? 8 : 7))
            }
        }
        if let urlRange = text.range(of: #"https?://[A-Za-z0-9._-]+"#, options: .regularExpression) {
            let urlStr = text[urlRange]
            return String(urlStr.dropFirst(urlStr.hasPrefix("https://") ? 8 : 7))
        }
        return nil
    }

    private static func summariseFailure(buf: String, code: Int32) -> String {
        let lower = buf.lowercased()
        if lower.contains("permission denied") {
            return "ssh permission denied — check the key is registered with sish"
        }
        if lower.contains("could not resolve") || lower.contains("name or service not known") {
            return "could not resolve tunnel server"
        }
        if lower.contains("connection refused") {
            return "connection refused by tunnel server"
        }
        if lower.contains("connection timed out") || lower.contains("operation timed out") {
            return "tunnel server timed out"
        }
        // Last line of buffer is usually the most informative when ssh dies.
        let lastLine = buf
            .split(separator: "\n", omittingEmptySubsequences: true)
            .last
            .map(String.init)?
            .trimmingCharacters(in: .whitespaces)
        if let lastLine, !lastLine.isEmpty, lastLine.count < 200 {
            return lastLine
        }
        return "ssh exited (code \(code))"
    }
}

/// Strip ANSI escape sequences from a string. Mirrors the parsing logic in
/// `ANSI.attributedString` but discards style and returns a plain string —
/// suitable for regex matching against sish's coloured banner.
enum AnsiStripping {
    static func strip(_ raw: String) -> String {
        var out = ""
        let scalars = Array(raw.unicodeScalars)
        var i = 0
        while i < scalars.count {
            let s = scalars[i]
            if s.value == 0x1B, i + 1 < scalars.count, scalars[i + 1] == "[" {
                // Skip CSI parameters until the final byte (0x40..0x7E).
                var j = i + 2
                while j < scalars.count {
                    let cj = scalars[j]
                    if cj.value >= 0x40 && cj.value <= 0x7E {
                        j += 1
                        break
                    }
                    j += 1
                }
                i = j
            } else {
                out.unicodeScalars.append(s)
                i += 1
            }
        }
        return out
    }
}
