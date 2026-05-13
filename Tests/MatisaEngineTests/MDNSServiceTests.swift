import XCTest
import MatisaCore
@testable import MatisaEngine

/// Tests `MDNSService` via its closure-based injection seams. The real
/// `dns-sd` binary isn't touched — we substitute `/bin/sleep` (silent,
/// long-lived) when we want a spawn to succeed without flipping to
/// `.active`, or nil-out the path when we want the no-binary error.
final class MDNSServiceTests: XCTestCase {

    // MARK: - Helpers

    private func waitUntil(
        timeout: TimeInterval = 1,
        _ condition: () -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(10_000)
        }
        return condition()
    }

    private func makeService(
        name: String = "web",
        state: ServiceState = .running(pid: 1234, since: Date(timeIntervalSince1970: 1)),
        port: Int = 5173
    ) -> Service {
        Service(
            spec: .project(ProjectFields(
                name: name,
                path: URL(fileURLWithPath: "/tmp/\(name)"),
                port: port,
                url: nil,
                command: "npm run dev",
                build: nil,
                scripts: [],
                group: nil,
                env: nil
            )),
            state: state,
            logsPath: nil
        )
    }

    // MARK: - toggle

    func testToggle_serviceNotFound_isNoOp() {
        let mdns = MDNSService(
            lookupService: { _ in nil },
            loadLocalNetworkConfig: { .defaults },
            dnsSDPath: { "/bin/echo" },
            primaryLANIPv4: { "192.168.1.10" }
        )
        mdns.toggle(serviceID: "project:nonexistent")
        XCTAssertEqual(mdns.status(serviceID: "project:nonexistent"), .idle)
        XCTAssertTrue(mdns.list().isEmpty)
    }

    func testToggle_noLANInterface_setsError() {
        let svc = makeService()
        let mdns = MDNSService(
            lookupService: { _ in svc },
            loadLocalNetworkConfig: { .defaults },
            dnsSDPath: { "/bin/echo" },
            primaryLANIPv4: { nil }
        )
        XCTAssertFalse(mdns.hasLANInterface)
        mdns.toggle(serviceID: svc.id)
        XCTAssertEqual(mdns.status(serviceID: svc.id), .error("no LAN interface available"))
    }

    func testToggle_advertisesThenUnpublishes() {
        let svc = makeService(name: "web")
        let mdns = MDNSService(
            lookupService: { _ in svc },
            loadLocalNetworkConfig: { .defaults },
            // `/usr/bin/true` accepts any args, exits 0 silently. We can't
            // assert that we *stayed* in `.advertising` deterministically —
            // the child may exit before we check — but we can assert the
            // first status mutation was `.advertising(web.matisa.local)`,
            // which lands synchronously inside `toggle`'s queue.sync.
            dnsSDPath: { "/usr/bin/true" },
            primaryLANIPv4: { "192.168.1.10" }
        )
        // Toggle on — the synchronous `toggle` returns only after the
        // status flips to `.advertising` for `web.matisa.local`. Whether
        // the child has exited yet is racy; the next mutation will be
        // either the markActive (no-op for true, no stdout) or
        // handleExit-induced .error. We only assert the immediate state.
        mdns.toggle(serviceID: svc.id)
        let postOn = mdns.status(serviceID: svc.id)
        XCTAssertNotEqual(postOn, .idle, "toggle-on should move status off .idle")
        if case .advertising(let h) = postOn {
            XCTAssertEqual(h, "web.matisa.local")
        } else if case .error = postOn {
            // Acceptable — the child has already exited and handleExit ran
            // ahead of our read. The hostname map still holds web.matisa.local;
            // toggle-off will still SIGTERM-and-clear it.
        } else {
            XCTFail("expected .advertising or .error, got \(postOn)")
        }

        // Toggle off — SIGTERMs the child (if still alive), wipes the
        // hostname, and lands back at `.idle`.
        mdns.toggle(serviceID: svc.id)
        XCTAssertEqual(mdns.status(serviceID: svc.id), .idle)
    }

    func testToggle_serviceNotRunning_isNoOp() {
        let svc = makeService(state: .stopped)
        let mdns = MDNSService(
            lookupService: { _ in svc },
            loadLocalNetworkConfig: { .defaults },
            dnsSDPath: { "/bin/echo" },
            primaryLANIPv4: { "192.168.1.10" }
        )
        mdns.toggle(serviceID: svc.id)
        XCTAssertEqual(mdns.status(serviceID: svc.id), .idle)
    }

    // MARK: - onStateChanged

    func testOnStateChanged_firesOnToggleOnAndOff() {
        let svc = makeService(name: "web")
        let counter = Counter()
        let mdns = MDNSService(
            lookupService: { _ in svc },
            loadLocalNetworkConfig: { .defaults },
            // `/usr/bin/true` exits immediately with no stdout; the
            // post-exit handler doesn't fire onStateChanged (matches
            // MDNSPublisher's behaviour — dns-sd exits don't re-render the
            // Caddyfile), so the counter only reflects toggle mutations.
            dnsSDPath: { "/usr/bin/true" },
            primaryLANIPv4: { "192.168.1.10" },
            onStateChanged: { counter.bump() }
        )
        XCTAssertEqual(counter.value, 0)
        mdns.toggle(serviceID: svc.id)
        XCTAssertEqual(counter.value, 1, "toggle-on should fire onStateChanged once")
        mdns.toggle(serviceID: svc.id)
        XCTAssertEqual(counter.value, 2, "toggle-off should fire onStateChanged once")
    }

    func testOnStateChanged_doesNotFire_onUnknownServiceID() {
        let counter = Counter()
        let mdns = MDNSService(
            lookupService: { _ in nil },
            loadLocalNetworkConfig: { .defaults },
            dnsSDPath: { "/bin/echo" },
            primaryLANIPv4: { "192.168.1.10" },
            onStateChanged: { counter.bump() }
        )
        mdns.toggle(serviceID: "project:nonexistent")
        XCTAssertEqual(counter.value, 0)
    }

    // MARK: - sanitisedHostname

    func testSanitisedHostname_basic() {
        XCTAssertEqual(
            MDNSService.sanitisedHostname(serviceName: "web", domain: "matisa.local"),
            "web.matisa.local"
        )
    }

    func testSanitisedHostname_collapsesAndTrimsDashes() {
        XCTAssertEqual(
            MDNSService.sanitisedHostname(serviceName: "My App!!!", domain: "matisa.local"),
            "my-app.matisa.local"
        )
    }

    func testSanitisedHostname_emptyAfterSanitise_fallsBack() {
        XCTAssertEqual(
            MDNSService.sanitisedHostname(serviceName: "!!!", domain: "matisa.local"),
            "service.matisa.local"
        )
    }
}

/// Sendable wrapper for tests — closures need `@Sendable` capture and Int
/// alone isn't enough.
private final class Counter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "test.counter")
    private var _value = 0
    func bump() { queue.sync { _value += 1 } }
    var value: Int { queue.sync { _value } }
}
