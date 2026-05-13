import XCTest
import MatisaCore
@testable import MatisaEngine

/// Tests `CaddyService` via the closure-based injection seams. The real brew
/// CLI and `caddy validate` binary aren't touched — those shell-outs are
/// exempt from coverage by design, same as the docker-daemon tests.
final class CaddyServiceTests: XCTestCase {

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

    private func makeConfig(caddyfile: URL?) -> AppConfig {
        AppConfig(
            caddyfile: caddyfile,
            services: [
                .project(ProjectFields(
                    name: "web",
                    path: URL(fileURLWithPath: "/tmp/web"),
                    port: 5173,
                    url: "web.localhost",
                    command: "npm run dev",
                    build: nil,
                    scripts: [],
                    group: nil,
                    env: nil
                )),
                .docker(DockerFields(
                    name: "api",
                    image: "ghcr.io/example/api:latest",
                    port: 8080,
                    url: "api.localhost",
                    scripts: [],
                    group: nil
                )),
            ],
            tunnel: .defaults,
            localNetwork: .defaults
        )
    }

    private func makeSnapshot(managed: [Service] = []) -> ServicesSnapshot {
        ServicesSnapshot(
            managed: managed,
            unmanaged: [],
            dockerDaemonRunning: false,
            takenAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
    }

    /// Build a `CaddyService` with defaults that never call the real binaries.
    /// Override individual closures via the parameters.
    private func makeService(
        config: AppConfig? = nil,
        snapshot: ServicesSnapshot? = nil,
        brewProbe: @escaping @Sendable () -> [BrewService] = { [] },
        brewStart: @escaping @Sendable (String) async throws -> Void = { _ in },
        brewStop: @escaping @Sendable (String) async throws -> Void = { _ in },
        brewRestart: @escaping @Sendable (String) async throws -> Void = { _ in },
        debounceNS: UInt64 = 150_000_000
    ) -> CaddyService {
        let cfg = config ?? makeConfig(caddyfile: nil)
        let snap = snapshot ?? makeSnapshot()
        return CaddyService(
            loadConfig: { cfg },
            loadServicesSnapshot: { snap },
            brewProbe: brewProbe,
            brewStart: brewStart,
            brewStop: brewStop,
            brewRestart: brewRestart,
            caddyBinaryLookup: { nil },
            runValidate: { _, _ in },
            debounceNS: debounceNS
        )
    }

    // MARK: - status()

    func testStatus_running_whenBrewListsCaddyStarted() {
        let svc = makeService(
            brewProbe: {
                [BrewService(name: "caddy", status: "started", user: "u", plist: "/p")]
            }
        )
        let info = svc.status()
        XCTAssertTrue(info.running)
    }

    func testStatus_notRunning_whenBrewListsCaddyStopped() {
        let svc = makeService(
            brewProbe: {
                [BrewService(name: "caddy", status: "stopped", user: "u", plist: "/p")]
            }
        )
        XCTAssertFalse(svc.status().running)
    }

    func testStatus_notRunning_whenBrewHasNoCaddy() {
        let svc = makeService(brewProbe: { [] })
        XCTAssertFalse(svc.status().running)
    }

    func testStatus_configFile_reflectsLoadedConfig() {
        let path = URL(fileURLWithPath: "/tmp/Caddyfile.matisa-test")
        let svc = makeService(config: makeConfig(caddyfile: path))
        XCTAssertEqual(svc.status().configFile, path)
    }

    // MARK: - Lifecycle wiring

    func testStart_callsBrewStart_withCaddyName() async throws {
        let received = Atomic<String?>(nil)
        let svc = makeService(brewStart: { name in received.set(name) })
        try await svc.start()
        XCTAssertEqual(received.value, "caddy")
    }

    func testStop_callsBrewStop_withCaddyName() async throws {
        let received = Atomic<String?>(nil)
        let svc = makeService(brewStop: { name in received.set(name) })
        try await svc.stop()
        XCTAssertEqual(received.value, "caddy")
    }

    func testRestart_callsBrewRestart_withCaddyName() async throws {
        let received = Atomic<String?>(nil)
        let svc = makeService(brewRestart: { name in received.set(name) })
        try await svc.restart()
        XCTAssertEqual(received.value, "caddy")
    }

    /// `reload` is a thin alias for `brew services restart caddy` — same
    /// behaviour as the app's pre-2d `reloadCaddy`.
    func testReload_callsBrewRestart_withCaddyName() async throws {
        let received = Atomic<String?>(nil)
        let svc = makeService(brewRestart: { name in received.set(name) })
        try await svc.reload()
        XCTAssertEqual(received.value, "caddy")
    }

    // MARK: - regenerate()

    func testRegenerate_returnsNil_whenNoCaddyfileConfigured() async throws {
        let svc = makeService(config: makeConfig(caddyfile: nil))
        let dest = try await svc.regenerate()
        XCTAssertNil(dest)
    }

    func testRegenerate_writesFileWithExpectedBlocks() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("matisa-caddy-\(UUID().uuidString).conf")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let svc = makeService(config: makeConfig(caddyfile: tmp))
        let dest = try await svc.regenerate()
        XCTAssertEqual(dest, tmp)

        let written = try String(contentsOf: tmp, encoding: .utf8)
        // Header + global block always present.
        XCTAssertTrue(written.contains("auto_https off"),
                      "expected auto_https off block; got:\n\(written)")
        // One block per declared URL in the config fixture.
        XCTAssertTrue(written.contains("http://web.localhost {"),
                      "expected web.localhost block; got:\n\(written)")
        XCTAssertTrue(written.contains("reverse_proxy localhost:5173"),
                      "expected web reverse_proxy; got:\n\(written)")
        XCTAssertTrue(written.contains("http://api.localhost {"),
                      "expected api.localhost block; got:\n\(written)")
        XCTAssertTrue(written.contains("reverse_proxy localhost:8080"),
                      "expected api reverse_proxy; got:\n\(written)")
        // 2d does not render exposure blocks — no `.matisa.local` entries.
        XCTAssertFalse(written.contains(".matisa.local"),
                       "exposures should be empty in 2d; got:\n\(written)")
    }

    // MARK: - scheduleRegenAndReload()

    /// Three rapid calls should collapse to a single regen + single reload.
    /// Use a short debounce window so the test resolves in tens of ms.
    func testScheduleRegenAndReload_coalescesRapidCalls() async {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("matisa-caddy-debounce-\(UUID().uuidString).conf")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let restartCount = Counter()
        let svc = makeService(
            config: makeConfig(caddyfile: tmp),
            brewRestart: { _ in restartCount.increment() },
            debounceNS: 30_000_000     // 30ms window
        )

        // Three calls inside the window — only the last should fire.
        svc.scheduleRegenAndReload()
        svc.scheduleRegenAndReload()
        svc.scheduleRegenAndReload()

        // Wait past the debounce window plus a margin for the regen+reload
        // to land.
        XCTAssertTrue(waitUntil(timeout: 1) { restartCount.value >= 1 })
        // Give a touch more time to catch any spurious second restart.
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(restartCount.value, 1, "debounce must coalesce to a single restart")

        // Side effect: the Caddyfile was regenerated exactly once and contains
        // the expected blocks.
        let written = try? String(contentsOf: tmp, encoding: .utf8)
        XCTAssertEqual(written?.contains("auto_https off"), true)
    }
}

// MARK: - Test helpers

/// Tiny thread-safe atomic. Used in place of pulling in NSLock just to
/// observe a closure-captured value across a Task boundary.
private final class Atomic<T>: @unchecked Sendable {
    private let queue = DispatchQueue(label: "test.caddy.atomic")
    private var _value: T
    init(_ initial: T) { self._value = initial }
    func set(_ newValue: T) { queue.sync { _value = newValue } }
    var value: T { queue.sync { _value } }
}

private final class Counter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "test.caddy.counter")
    private var _value: Int = 0
    func increment() { queue.sync { _value += 1 } }
    var value: Int { queue.sync { _value } }
}
