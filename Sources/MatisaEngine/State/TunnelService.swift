import Foundation
import MatisaCore

/// Engine-side owner of public tunnels (sish over SSH). Port of the app's
/// `TunnelManager` — one `Foundation.Process` per active tunnel, banner-parsed
/// hostnames from sish's stderr, lifecycle-aware auto-teardown.
///
/// State surface mirrors the app's TunnelManager:
///   - `[String: PublicTunnelStatus]` keyed by service id.
///   - `[String: Process]` keyed by service id for live SSH children.
///   - `[String: String]` keyed by service id for the (capped) stderr buffer
///     each tunnel accumulates while waiting for the host banner.
///
/// `toggle` mirrors the app's `togglePublicTunnel`: if the tunnel is active,
/// SIGTERM the child; if the service is running and the SSH key exists, spawn
/// `ssh -R any:80:...@<sish>`. All gating runs engine-side — RPC callers
/// don't preflight before calling. The status field carries any error message
/// the UI needs to render.
///
/// `reconcileAfterSnapshot` is the lifecycle-transition detector — called by
/// `ServicesService.snapshot()` right before returning each snapshot. It
/// tracks the last-seen state per service id and SIGTERMs any active tunnel
/// whose backing service just transitioned running → not-running. Same auto-
/// teardown semantics the app's pre-2e.1 `refresh()` ran inline.
///
/// Closure-injection on collaborators (`lookupService`, `loadTunnelConfig`,
/// `sshPath`, `keyExists`) keeps tests self-contained — they don't have to
/// stand up a real `ConfigService` / `ServicesService` to exercise the toggle
/// gating, and they can simulate "ssh not found" / "key missing" without
/// poking the filesystem.
///
/// Thread-safety: a serial `DispatchQueue` (`engine.tunnels`) guards every
/// piece of mutable state. `Process` pipe callbacks
/// (`readabilityHandler`, `terminationHandler`) arrive on Foundation worker
/// threads and marshal back onto the queue before touching the maps. Marked
/// `@unchecked Sendable` for the same reason `TaskService` is — Swift can't
/// see the queue invariant through the closures.
final class TunnelService: @unchecked Sendable {

    typealias ServiceLookup = @Sendable (String) throws -> Service?
    typealias TunnelConfigLoader = @Sendable () throws -> TunnelConfig

    private let lookupService: ServiceLookup
    private let loadTunnelConfig: TunnelConfigLoader
    private let sshPath: @Sendable () -> String?
    private let keyExists: @Sendable (URL) -> Bool

    private let queue = DispatchQueue(label: "engine.tunnels")

    /// Wire-visible status per service id. Read by `status()` and `list()`.
    private var statuses: [String: PublicTunnelStatus] = [:]

    /// Live SSH `Process` handles per service id. Kept separate from the
    /// wire-visible status so the wire type stays process-management-free.
    private var processes: [String: Process] = [:]

    /// Per-service stderr+stdout buffer, capped at `bufferCap`. Drives the
    /// host-extraction regex while we're still in `.connecting` and feeds the
    /// failure-summary heuristic on early exit.
    private var buffers: [String: String] = [:]

    /// Lifecycle-transition tracker for `reconcileAfterSnapshot`. Same `[id ->
    /// last-seen state]` dict the app's pre-2e.1 `refresh()` kept inline; the
    /// engine now owns it so the auto-teardown fires before clients observe a
    /// service flipping to not-running.
    private var lastSeenStateByID: [String: ServiceState] = [:]

    /// 16KB cap on retained output per tunnel. Sish banners are tiny but
    /// long-running connections still print connection logs; bound the
    /// memory anyway. Matches the app's TunnelManager value.
    private let bufferCap = 16_000

    init(
        lookupService: @escaping ServiceLookup,
        loadTunnelConfig: @escaping TunnelConfigLoader,
        sshPath: @escaping @Sendable () -> String? = { SyncShell.which("ssh") },
        keyExists: @escaping @Sendable (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }
    ) {
        self.lookupService = lookupService
        self.loadTunnelConfig = loadTunnelConfig
        self.sshPath = sshPath
        self.keyExists = keyExists
    }

    // MARK: - Reads

    /// Status for a single service. Returns `.idle` for unknown ids.
    func status(serviceID: String) -> PublicTunnelStatus {
        queue.sync { statuses[serviceID] ?? .idle }
    }

    /// All tracked statuses. Includes `.idle` entries for services that were
    /// ever active and haven't been cleared since — the app's mirror code
    /// treats absent and `.idle` the same way.
    func list() -> [String: PublicTunnelStatus] {
        queue.sync { statuses }
    }

    // MARK: - Toggle

    /// Toggle the public tunnel for `serviceID`. If currently active, SIGTERM
    /// the SSH child; otherwise (and only if the service is running and the
    /// SSH key exists) spawn a fresh ssh process. All preflight failures land
    /// on the status field — callers don't need to introspect the result.
    func toggle(serviceID: String) {
        queue.sync { toggleLocked(serviceID: serviceID) }
    }

    private func toggleLocked(serviceID: String) {
        if statuses[serviceID]?.isActive == true {
            stopLocked(serviceID: serviceID)
            return
        }

        // Resolve target service + tunnel config. A throwing config load
        // (e.g. bun missing / syntax error) becomes an error status rather
        // than a thrown RPC — the toggle is silently a no-op otherwise.
        let service: Service?
        let tunnel: TunnelConfig
        do {
            service = try lookupService(serviceID)
            tunnel = try loadTunnelConfig()
        } catch {
            statuses[serviceID] = .error("config load failed: \(error)")
            return
        }

        guard let service else {
            // No-op silently for unknown ids — the user only ever toggles
            // services they can see, so this only fires if the snapshot has
            // drifted out from under the UI. Keep the status untouched.
            return
        }

        guard service.state.isRunning else {
            // No status mutation here either — the Share menu is disabled
            // for non-running services on the app side, so an in-flight RPC
            // means a race we'd rather not paper over with an error label.
            return
        }

        guard let sshBin = sshPath() else {
            statuses[serviceID] = .error("ssh not found in PATH")
            return
        }
        guard keyExists(tunnel.sshKeyPath) else {
            statuses[serviceID] = .error("ssh key not found at \(tunnel.sshKeyPath.path)")
            return
        }
        guard let port = service.spec.exposedPorts.first?.port else { return }

        startLocked(
            serviceID: serviceID,
            port: port,
            hostHeader: service.spec.primaryURL,
            tunnel: tunnel,
            sshBin: sshBin
        )
    }

    // MARK: - Reconciliation

    /// Detect services that just transitioned running → not-running since
    /// the last snapshot and tear down their active tunnels. Called by
    /// `ServicesService.snapshot()` before returning each snapshot so the
    /// teardown fires inside the same tick that exposes the transition to
    /// clients — they never see "service stopped, tunnel still live".
    ///
    /// Unmanaged entries are skipped — we never started a tunnel for them
    /// (the toggle path checks `state.isRunning` which is true for
    /// `.unmanaged`, but the Share menu surface is project/docker-only).
    func reconcileAfterSnapshot(_ managed: [Service]) {
        queue.sync {
            for svc in managed {
                let prev = lastSeenStateByID[svc.id]
                let nowRunning = svc.state.isRunning
                let wasRunning = prev?.isRunning ?? false
                if wasRunning && !nowRunning,
                   statuses[svc.id]?.isActive == true {
                    stopLocked(serviceID: svc.id)
                }
                lastSeenStateByID[svc.id] = svc.state
            }
        }
    }

    // MARK: - Locked helpers (must be called from `queue`)

    /// Start an SSH reverse tunnel. The shape of the argument vector and the
    /// pipe wiring mirrors the app's TunnelManager byte-for-byte — see that
    /// file for the rationale on each `-o` flag.
    private func startLocked(
        serviceID: String,
        port: Int,
        hostHeader: String?,
        tunnel: TunnelConfig,
        sshBin: String
    ) {
        // Idempotent — a double-toggle while connecting/live is a no-op.
        // Matches the app's `if statuses[serviceID]?.isActive == true { return }`.
        if statuses[serviceID]?.isActive == true { return }

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
        process.executableURL = URL(fileURLWithPath: sshBin)
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
            self?.queue.async { [weak self] in
                self?.ingestLocked(serviceID: serviceID, chunk: text)
            }
        }
        outPipe.fileHandleForReading.readabilityHandler = onChunk
        errPipe.fileHandleForReading.readabilityHandler = onChunk

        process.terminationHandler = { [weak self] proc in
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            let code = proc.terminationStatus
            self?.queue.async { [weak self] in
                self?.markExitedLocked(serviceID: serviceID, code: code)
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

    /// SIGTERM the SSH process for this service. No-op if not running. Sets
    /// the status to `.idle` unconditionally — the app's pre-2e.1 TunnelManager
    /// had two byte-identical methods (`stop` and `stopBecauseServiceStopped`),
    /// both leaving the status `.idle`. We collapse them.
    private func stopLocked(serviceID: String) {
        if let process = processes.removeValue(forKey: serviceID) {
            if process.isRunning {
                process.terminate()
            }
        }
        buffers.removeValue(forKey: serviceID)
        statuses[serviceID] = .idle
    }

    private func ingestLocked(serviceID: String, chunk: String) {
        let stripped = AnsiStripping.strip(chunk)
        var buf = (buffers[serviceID] ?? "") + stripped
        // Cap to keep memory bounded — sish banners are tiny but a long-running
        // tunnel can still accumulate connection logs over time.
        if buf.count > bufferCap { buf = String(buf.suffix(bufferCap)) }
        buffers[serviceID] = buf

        // Only look for the URL while we're still waiting for it; once .live,
        // skip the regex on every chunk.
        if case .connecting = statuses[serviceID] ?? .idle,
           let host = Self.extractHost(buf) {
            statuses[serviceID] = .live(url: "https://\(host)")
        }
    }

    private func markExitedLocked(serviceID: String, code: Int32) {
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

    // MARK: - Banner parsing

    /// Pull the HTTP host out of a sish banner. sish prints lines like
    /// `HTTP: http://abcd1234.tunnel.westopp.com` (with optional ANSI colour
    /// codes around it). We strip ANSI before this runs.
    static func extractHost(_ text: String) -> String? {
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

/// Strip ANSI escape sequences from a string. Engine-side copy of the app's
/// `AnsiStripping` enum in `TunnelManager.swift` — the engine doesn't share
/// app Sources and we don't want a one-off MatisaCore home for a 25-line
/// helper that's strictly an implementation detail of tunnel parsing.
private enum AnsiStripping {
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
