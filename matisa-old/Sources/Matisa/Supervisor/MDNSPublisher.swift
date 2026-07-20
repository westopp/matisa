import Foundation
import MatisaCore
import Observation
import Network
import Darwin

/// Advertises `<service>.<domain>` (e.g. `myapp.matisa.local`) on the local
/// network via mDNS, using the `dns-sd` CLI to register an A record pointing
/// at the laptop's primary non-loopback IPv4 address.
///
/// Why `dns-sd` rather than `NetService`/`DNSServiceRegisterRecord`:
/// `NetService` advertises *services* (typed Bonjour records like `_http._tcp`),
/// which devices discover via Bonjour browsers — not via plain DNS lookups.
/// What we need is the OS to answer `myapp.matisa.local` to a normal `getaddrinfo`
/// from a phone's browser. macOS's `dns-sd -P` registers a proxy hostname that
/// the system mDNSResponder answers for, which is exactly the behaviour we
/// want and the simplest reliable path to it.
///
/// One `dns-sd -P` child process per active hostname. NWPathMonitor watches
/// for Wi-Fi switches / sleep-wake and we re-publish on IP changes.
@MainActor
@Observable
final class MDNSPublisher {
    private(set) var statuses: [String: SameNetworkStatus] = [:]

    /// Mapping of service id → currently-published hostname (without trailing dot).
    /// Survives transient errors and IP changes.
    private(set) var hostnames: [String: String] = [:]

    /// Current LAN IPv4 address. nil when no non-loopback interface is up.
    private(set) var currentIP: String?

    private var processes: [String: Process] = [:]
    private var monitor: NWPathMonitor?
    private let monitorQueue = DispatchQueue(label: "dev.thulane.matisa.mdns.path")

    init() {
        currentIP = Self.primaryLANIPv4()
        startNetworkMonitoring()
    }

    func status(for serviceID: String) -> SameNetworkStatus {
        statuses[serviceID] ?? .idle
    }

    /// True when the laptop has a non-loopback IPv4 interface up. The Share
    /// menu uses this to disable the same-network item when there's no LAN
    /// to advertise on.
    var hasLANInterface: Bool { currentIP != nil }

    /// Begin advertising `<sanitisedName>.<domain>` for this service. Returns
    /// the chosen hostname so callers can wire it into the Caddyfile.
    @discardableResult
    func advertise(serviceID: String, serviceName: String, domain: String) -> String {
        let hostname = Self.sanitisedHostname(serviceName: serviceName, domain: domain)
        hostnames[serviceID] = hostname

        guard let ip = currentIP else {
            statuses[serviceID] = .error("no LAN interface available")
            return hostname
        }

        statuses[serviceID] = .advertising(hostname: hostname)
        spawnDNSSD(serviceID: serviceID, hostname: hostname, ip: ip)
        return hostname
    }

    /// Stop advertising for this service.
    func unpublish(serviceID: String) {
        if let process = processes.removeValue(forKey: serviceID), process.isRunning {
            process.terminate()
        }
        hostnames.removeValue(forKey: serviceID)
        statuses[serviceID] = .idle
    }

    /// Replace the status map with the engine's view, wholesale — **except**
    /// for service ids whose local Process is still live. Those advertisements
    /// were spawned by the local-fallback path during an engine-unreachable
    /// window; the engine has no record of them, and wiping their status
    /// would orphan the dns-sd child. Same shape as
    /// `TunnelManager.replaceStatusesFromEngine`.
    func replaceStatusesFromEngine(_ engineStatuses: [String: SameNetworkStatus]) {
        var nextStatuses: [String: SameNetworkStatus] = [:]
        var nextHostnames: [String: String] = [:]
        // Preserve locally-spawned (and still alive) advertisements. Their
        // hostnames live in the local `hostnames` map so refresh-on-IP-change
        // continues to work for them.
        for (id, status) in statuses {
            if let proc = processes[id], proc.isRunning {
                nextStatuses[id] = status
                if let h = hostnames[id] { nextHostnames[id] = h }
            }
        }
        // Overlay the engine's view. The engine owns its own advertisements
        // and doesn't see app-spawned ones, so collisions only happen on
        // engine-recovery — the engine's view wins in that rare case. We
        // also lift the hostname out of the status payload so the local
        // refresh-on-IP-change path has it if the user ever crosses back
        // into a local-fallback session for the same service.
        for (id, status) in engineStatuses {
            nextStatuses[id] = status
            if let h = status.hostname { nextHostnames[id] = h }
        }
        statuses = nextStatuses
        hostnames = nextHostnames
    }

    /// Re-spawn dns-sd processes after a network change, pointing at the new IP.
    /// No-op for services not currently advertising.
    func refreshAdvertisements() {
        guard let ip = currentIP else {
            // Lost the network — kill all dns-sd processes but keep the
            // hostnames map so we can re-advertise when an interface comes back.
            for (id, process) in processes {
                if process.isRunning { process.terminate() }
                processes.removeValue(forKey: id)
                statuses[id] = .error("no LAN interface available")
            }
            return
        }
        for (id, hostname) in hostnames {
            if let process = processes[id], process.isRunning {
                process.terminate()
            }
            processes.removeValue(forKey: id)
            statuses[id] = .advertising(hostname: hostname)
            spawnDNSSD(serviceID: id, hostname: hostname, ip: ip)
        }
    }

    // MARK: - dns-sd

    private func spawnDNSSD(serviceID: String, hostname: String, ip: String) {
        guard let dnsSD = Shell.which("dns-sd") else {
            statuses[serviceID] = .error("dns-sd not found in PATH")
            return
        }

        // `dns-sd -P <name> <type> <domain> <port> <hostname.> <ip> [TXT...]`
        // We use the proxy mode to register a hostname that mDNSResponder
        // will resolve for plain getaddrinfo lookups. The service type and
        // port don't matter for hostname resolution but are required args.
        // We strip the `.local` suffix from the leaf because dns-sd appends
        // it via the domain argument.
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
            ip
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
            Task { @MainActor [weak self] in
                self?.handleExit(serviceID: serviceID, code: code)
            }
        }

        // dns-sd announces immediately on success. Mark .active after a tiny
        // beat so the UI doesn't flash through .advertising on most paths.
        let outHandle = outPipe.fileHandleForReading
        outHandle.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { return }
            Task { @MainActor [weak self] in
                self?.markActive(serviceID: serviceID, hostname: hostname)
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

    private func markActive(serviceID: String, hostname: String) {
        if case .advertising = statuses[serviceID] ?? .idle {
            statuses[serviceID] = .active(hostname: hostname)
        }
    }

    private func handleExit(serviceID: String, code: Int32) {
        processes.removeValue(forKey: serviceID)
        // If the user explicitly unpublished, status is already .idle.
        switch statuses[serviceID] ?? .idle {
        case .idle:
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
            Task { @MainActor [weak self] in
                self?.handlePathUpdate()
            }
        }
        monitor.start(queue: monitorQueue)
        self.monitor = monitor
    }

    private func handlePathUpdate() {
        let newIP = Self.primaryLANIPv4()
        if newIP == currentIP { return }
        currentIP = newIP
        refreshAdvertisements()
    }

    // MARK: - Helpers

    /// First non-loopback IPv4 address bound to a UP interface. Falls back to
    /// nil when only loopback is available (useful for the disabled-state
    /// guard in the Share menu).
    static func primaryLANIPv4() -> String? {
        var ifaddrPtr: UnsafeMutablePointer<ifaddrs>? = nil
        guard getifaddrs(&ifaddrPtr) == 0, let first = ifaddrPtr else { return nil }
        defer { freeifaddrs(ifaddrPtr) }

        var candidates: [(String, String)] = []  // (ifname, ip)
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

        // Prefer en0 (Wi-Fi on most Macs), then en* (other Ethernet/Thunderbolt),
        // then anything else.
        if let wifi = candidates.first(where: { $0.0 == "en0" }) { return wifi.1 }
        if let en = candidates.first(where: { $0.0.hasPrefix("en") }) { return en.1 }
        return candidates.first?.1
    }

    /// Lower-case a service name and strip characters that are illegal in DNS
    /// labels. Empty results fall back to "service" so we never advertise
    /// `.matisa.local` with no leaf.
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
