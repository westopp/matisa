import Foundation
import MatisaCore
import Network
import Darwin

/// Engine-side owner of same-network (mDNS) exposure. Port of the app's
/// `MDNSPublisher` — one `dns-sd -P` child per active hostname, an
/// `NWPathMonitor` watching for Wi-Fi switches / sleep-wake, the same
/// `sanitisedHostname` / `primaryLANIPv4` algorithms.
///
/// Why `dns-sd` rather than `NetService` / `DNSServiceRegisterRecord`:
/// `NetService` advertises Bonjour *services* (typed records like
/// `_http._tcp`), which devices discover via Bonjour browsers — not via
/// plain DNS lookups. What we need is the OS to answer
/// `<service>.matisa.local` to a normal `getaddrinfo` from a phone's
/// browser. `dns-sd -P` registers a proxy hostname that mDNSResponder
/// answers for, which is exactly the behaviour we want and the simplest
/// reliable path to it.
///
/// State surface mirrors `TunnelService`:
///   - `[String: SameNetworkStatus]` keyed by service id.
///   - `[String: Process]` keyed by service id for live `dns-sd -P` children.
///   - `[String: String]` keyed by service id for the currently-published
///     hostname; survives transient errors and IP changes.
///
/// `toggle` mirrors the app's `toggleSameNetwork`: if the service is
/// already advertising/active, terminate the child; otherwise resolve the
/// service + domain and spawn `dns-sd -P`. All gating runs engine-side; the
/// caller doesn't preflight.
///
/// Unlike `TunnelService`, mDNS does **not** auto-teardown when its
/// backing service stops. Visitors get a Caddy 502 rather than a DNS error,
/// which is more diagnosable — the app's pre-2e.2 behaviour. No
/// `reconcileAfterSnapshot` hook.
///
/// `onStateChanged` fires after every state mutation that affects the
/// rendered Caddyfile (toggle → start, toggle → stop, `refreshAdvertisements`
/// re-publish, `markActive` transition). The engine wires this to
/// `CaddyService.scheduleRegenAndReload` so the rendered Caddyfile picks up
/// new / removed `<service>.matisa.local` blocks within the 150ms debounce
/// window. Tests pass an empty `{}`.
///
/// Thread-safety: a serial `DispatchQueue` (`engine.mdns`) guards every
/// piece of mutable state. `Process` pipe callbacks
/// (`readabilityHandler`, `terminationHandler`) and `NWPathMonitor`
/// updates arrive on Foundation worker threads and marshal back onto the
/// queue before touching the maps. Marked `@unchecked Sendable` for the
/// same reason `TunnelService` is.
final class MDNSService: @unchecked Sendable {

    typealias ServiceLookup = @Sendable (String) throws -> Service?
    typealias LocalNetworkConfigLoader = @Sendable () throws -> LocalNetworkConfig

    private let lookupService: ServiceLookup
    private let loadLocalNetworkConfig: LocalNetworkConfigLoader
    private let dnsSDPath: @Sendable () -> String?
    private let primaryLANIPv4Lookup: @Sendable () -> String?
    private let onStateChanged: @Sendable () -> Void

    private let queue = DispatchQueue(label: "engine.mdns")
    private let monitorQueue = DispatchQueue(label: "engine.mdns.path")

    /// Wire-visible status per service id. Read by `status()` and `list()`.
    private var statuses: [String: SameNetworkStatus] = [:]

    /// Live `dns-sd -P` `Process` handles per service id.
    private var processes: [String: Process] = [:]

    /// Mapping of service id → currently-published hostname (without
    /// trailing dot). Survives transient errors and IP changes so
    /// `refreshAdvertisements` can re-spawn after a network change.
    private var hostnames: [String: String] = [:]

    /// Current primary LAN IPv4. `nil` when no non-loopback IPv4 interface
    /// is up. Stored so path-update events can short-circuit when nothing
    /// actually changed.
    private var currentIP: String?

    /// Lives for the process lifetime. No teardown method — the engine
    /// itself is the only owner.
    private var monitor: NWPathMonitor?

    init(
        lookupService: @escaping ServiceLookup,
        loadLocalNetworkConfig: @escaping LocalNetworkConfigLoader,
        dnsSDPath: @escaping @Sendable () -> String? = { SyncShell.which("dns-sd") },
        primaryLANIPv4: @escaping @Sendable () -> String? = { MDNSService.defaultPrimaryLANIPv4() },
        onStateChanged: @escaping @Sendable () -> Void = {}
    ) {
        self.lookupService = lookupService
        self.loadLocalNetworkConfig = loadLocalNetworkConfig
        self.dnsSDPath = dnsSDPath
        self.primaryLANIPv4Lookup = primaryLANIPv4
        self.onStateChanged = onStateChanged
        self.currentIP = primaryLANIPv4()
        startNetworkMonitoring()
    }

    // MARK: - Reads

    /// Status for a single service. Returns `.idle` for unknown ids.
    func status(serviceID: String) -> SameNetworkStatus {
        queue.sync { statuses[serviceID] ?? .idle }
    }

    /// All tracked statuses. Includes `.idle` entries for services that
    /// were ever active and haven't been cleared since — the app's mirror
    /// code treats absent and `.idle` the same way.
    func list() -> [String: SameNetworkStatus] {
        queue.sync { statuses }
    }

    /// True when a non-loopback IPv4 interface is up. Used by the engine's
    /// toggle path to set `.error("no LAN interface available")` when the
    /// laptop has no LAN. The Share menu uses the *app-side* MDNSPublisher's
    /// `hasLANInterface` for its disabled-state predicate; the engine
    /// doesn't expose this over the wire.
    var hasLANInterface: Bool {
        queue.sync { currentIP != nil }
    }

    // MARK: - Toggle

    /// Toggle same-network exposure for `serviceID`. If currently
    /// advertising/active, terminate the `dns-sd` child; otherwise resolve
    /// the service + domain and start advertising. Fires `onStateChanged`
    /// after the mutation lands.
    func toggle(serviceID: String) {
        let changed = queue.sync { toggleLocked(serviceID: serviceID) }
        if changed { onStateChanged() }
    }

    /// Re-spawn dns-sd children pointing at the new primary IP. Called
    /// from the internal `NWPathMonitor` handler on path-change events.
    /// Exposed for tests; production calls it itself.
    func refreshAdvertisements() {
        let changed = queue.sync { refreshAdvertisementsLocked() }
        if changed { onStateChanged() }
    }

    // MARK: - Locked helpers (must be called from `queue`)

    /// Returns `true` when state actually changed (so `onStateChanged`
    /// fires). Unknown-id no-ops and "service not running" no-ops return
    /// `false`.
    private func toggleLocked(serviceID: String) -> Bool {
        if statuses[serviceID]?.isActive == true {
            stopLocked(serviceID: serviceID)
            return true
        }

        // Resolve target service + local-network config. A throwing config
        // load becomes an error status rather than a thrown RPC — the
        // toggle is silently a no-op otherwise. Same shape as
        // TunnelService.toggleLocked.
        let service: Service?
        let local: LocalNetworkConfig
        do {
            service = try lookupService(serviceID)
            local = try loadLocalNetworkConfig()
        } catch {
            statuses[serviceID] = .error("config load failed: \(error)")
            return true
        }

        guard let service else {
            // No-op for unknown ids — the user only toggles services they
            // can see, so this only fires if the snapshot has drifted.
            return false
        }

        guard service.state.isRunning else {
            // Share menu is disabled for non-running services; an in-flight
            // RPC here means a race we'd rather not paper over.
            return false
        }

        let hostname = Self.sanitisedHostname(
            serviceName: service.name,
            domain: local.domain
        )
        hostnames[serviceID] = hostname

        guard let ip = currentIP else {
            statuses[serviceID] = .error("no LAN interface available")
            return true
        }

        statuses[serviceID] = .advertising(hostname: hostname)
        spawnDNSSDLocked(serviceID: serviceID, hostname: hostname, ip: ip)
        return true
    }

    /// SIGTERM the dns-sd process for this service. Clears the hostname so
    /// the next path-update doesn't try to re-publish it.
    private func stopLocked(serviceID: String) {
        if let process = processes.removeValue(forKey: serviceID) {
            if process.isRunning { process.terminate() }
        }
        hostnames.removeValue(forKey: serviceID)
        statuses[serviceID] = .idle
    }

    /// Returns `true` when any per-service state actually changed.
    private func refreshAdvertisementsLocked() -> Bool {
        let newIP = primaryLANIPv4Lookup()
        if newIP == currentIP { return false }
        currentIP = newIP

        guard let ip = newIP else {
            // Lost the network — kill all dns-sd processes but keep the
            // hostnames map so we can re-advertise when an interface
            // comes back.
            var changed = false
            for (id, process) in processes {
                if process.isRunning { process.terminate() }
                processes.removeValue(forKey: id)
                statuses[id] = .error("no LAN interface available")
                changed = true
            }
            return changed
        }

        var changed = false
        for (id, hostname) in hostnames {
            if let process = processes[id], process.isRunning {
                process.terminate()
            }
            processes.removeValue(forKey: id)
            statuses[id] = .advertising(hostname: hostname)
            spawnDNSSDLocked(serviceID: id, hostname: hostname, ip: ip)
            changed = true
        }
        return changed
    }

    private func spawnDNSSDLocked(serviceID: String, hostname: String, ip: String) {
        guard let dnsSD = dnsSDPath() else {
            statuses[serviceID] = .error("dns-sd not found in PATH")
            return
        }

        // `dns-sd -P <name> <type> <domain> <port> <hostname.> <ip> [TXT...]`.
        // Proxy mode registers a hostname mDNSResponder will resolve for
        // plain getaddrinfo lookups. The service type and port don't matter
        // for hostname resolution but are required args. We strip the
        // `.local` suffix from the leaf because dns-sd appends it via the
        // domain argument.
        let leaf = hostname.replacingOccurrences(of: ".local", with: "")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: dnsSD)
        process.arguments = [
            "-P",
            leaf,
            "_http._tcp",
            "local",
            "80",
            hostname,
            ip,
        ]

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        if let devNull = FileHandle(forReadingAtPath: "/dev/null") {
            process.standardInput = devNull
        }

        process.terminationHandler = { [weak self] proc in
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            let code = proc.terminationStatus
            self?.queue.async { [weak self] in
                self?.handleExitLocked(serviceID: serviceID, code: code)
            }
        }

        // dns-sd announces immediately on success. Mark .active after the
        // first stdout chunk so the UI doesn't flash through .advertising
        // on most paths.
        let outHandle = outPipe.fileHandleForReading
        outHandle.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { return }
            self?.queue.async { [weak self] in
                self?.markActiveLocked(serviceID: serviceID, hostname: hostname)
            }
        }
        errPipe.fileHandleForReading.readabilityHandler = nil

        do {
            try process.run()
            processes[serviceID] = process
        } catch {
            statuses[serviceID] = .error("failed to spawn dns-sd: \(error)")
        }
    }

    private func markActiveLocked(serviceID: String, hostname: String) {
        // The status might have been overwritten by a stop or refresh
        // between spawn and first-chunk. Only flip if we're still in
        // `.advertising` for this hostname.
        guard case .advertising = statuses[serviceID] ?? .idle else { return }
        statuses[serviceID] = .active(hostname: hostname)
        // Fire onStateChanged inline — we're already on the serial queue,
        // and the wired closure (CaddyService.scheduleRegenAndReload) just
        // schedules a Task, so it doesn't re-enter the queue.
        onStateChanged()
    }

    private func handleExitLocked(serviceID: String, code: Int32) {
        processes.removeValue(forKey: serviceID)
        switch statuses[serviceID] ?? .idle {
        case .idle:
            // Stop was requested, nothing to report.
            break
        default:
            if hostnames[serviceID] != nil {
                statuses[serviceID] = .error("dns-sd exited (code \(code))")
            } else {
                statuses[serviceID] = .idle
            }
        }
    }

    // MARK: - Network monitoring

    private func startNetworkMonitoring() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] _ in
            self?.refreshAdvertisements()
        }
        monitor.start(queue: monitorQueue)
        self.monitor = monitor
    }

    // MARK: - Helpers

    /// First non-loopback IPv4 address bound to a UP interface. Falls back
    /// to nil when only loopback is available. Verbatim port of
    /// `MDNSPublisher.primaryLANIPv4`.
    static func defaultPrimaryLANIPv4() -> String? {
        var ifaddrPtr: UnsafeMutablePointer<ifaddrs>? = nil
        guard getifaddrs(&ifaddrPtr) == 0, let first = ifaddrPtr else { return nil }
        defer { freeifaddrs(ifaddrPtr) }

        var candidates: [(String, String)] = []
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = ptr {
            defer { ptr = cur.pointee.ifa_next }
            let flags = Int32(cur.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0 else { continue }
            guard let addr = cur.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: cur.pointee.ifa_name)
            // Skip utun (VPN) and awdl (AirDrop) — they're up but not the
            // interface other devices on the LAN can reach us on.
            if name.hasPrefix("utun") || name.hasPrefix("awdl") || name.hasPrefix("llw") { continue }

            var hostBuf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let rc = getnameinfo(
                addr,
                socklen_t(addr.pointee.sa_len),
                &hostBuf,
                socklen_t(hostBuf.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            if rc != 0 { continue }
            let ip = String(cString: hostBuf)
            if ip.isEmpty || ip == "127.0.0.1" { continue }
            candidates.append((name, ip))
        }

        // Prefer en0 (Wi-Fi on most Macs), then en* (other Ethernet /
        // Thunderbolt), then anything else.
        if let wifi = candidates.first(where: { $0.0 == "en0" }) { return wifi.1 }
        if let en = candidates.first(where: { $0.0.hasPrefix("en") }) { return en.1 }
        return candidates.first?.1
    }

    /// Lower-case a service name and strip characters that are illegal in
    /// DNS labels. Empty results fall back to "service" so we never
    /// advertise `.matisa.local` with no leaf. Verbatim port of
    /// `MDNSPublisher.sanitisedHostname`.
    static func sanitisedHostname(serviceName: String, domain: String) -> String {
        let allowed = CharacterSet.lowercaseLetters
            .union(.decimalDigits)
            .union(CharacterSet(charactersIn: "-"))
        var leaf = serviceName.lowercased().unicodeScalars.map { scalar -> Character in
            allowed.contains(scalar) ? Character(scalar) : "-"
        }
        // Collapse runs of dashes and trim them off the ends.
        var collapsed = ""
        var lastWasDash = false
        for ch in leaf {
            if ch == "-" {
                if !lastWasDash { collapsed.append(ch) }
                lastWasDash = true
            } else {
                collapsed.append(ch)
                lastWasDash = false
            }
        }
        let trimmed = collapsed.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        leaf = Array(trimmed.isEmpty ? "service" : trimmed)
        return "\(String(leaf)).\(domain)"
    }
}
