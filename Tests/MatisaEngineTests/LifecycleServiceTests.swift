import XCTest
import Darwin
import MatisaCore
@testable import MatisaEngine

/// Exercises the engine's lifecycle orchestrator end-to-end against the real
/// posix_spawn / file-system / state-store stack — no mocking the syscall
/// boundary. The pieces that genuinely need a daemon (docker / compose
/// dispatch) live behind the `actionNeedsDocker` gate, which is tested via
/// the manual `nc -U` probe documented in the 2c.2 plan — we don't try to
/// simulate "daemon down" here because we can't safely stop a real one and
/// stubbing the probe gives us a tautology.
///
/// Each test uses a per-instance temp state file and a unique service id so
/// runs don't collide.
final class LifecycleServiceTests: XCTestCase {

    // MARK: - Test helpers

    private func tempStateFile() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("matisa-lifecycle-state-\(UUID().uuidString).json")
    }

    private func uniqueProjectName(_ tag: String) -> String {
        "lifecycle-test-\(tag)-\(UUID().uuidString.prefix(8))"
    }

    /// Build a synthetic project Service for an in-memory lookup. Same shape
    /// the engine would produce from a real config + state merge.
    private func projectService(
        name: String,
        path: URL,
        command: String,
        port: Int = 0,
        state: ServiceState = .stopped
    ) -> Service {
        let id = "project:\(name)"
        let f = ProjectFields(
            name: name,
            path: path,
            port: port,
            url: nil,
            command: command,
            build: nil,
            scripts: [],
            group: nil,
            env: nil
        )
        return Service(
            spec: .project(f),
            state: state,
            logsPath: CorePaths.logFile(for: id)
        )
    }

    /// Reap any exited child so `isAlive` can return false within this
    /// process. The engine's production path doesn't need this — children
    /// are orphans there — but in-test we own the parent.
    @discardableResult
    private func tryReap(_ pid: pid_t) -> Bool {
        var status: Int32 = 0
        return waitpid(pid, &status, WNOHANG) != 0
    }

    /// Make a LifecycleService that resolves a single in-memory Service. The
    /// closure captures the service so callers can swap it out by holding a
    /// reference and mutating in place (rare — most tests just use a fixed
    /// service). `dockerDaemonProbe` defaults to `true` so docker-gated paths
    /// aren't rejected; tests that exercise project lifecycle don't depend
    /// on it.
    private func makeService(
        for service: Service,
        stateFile: URL,
        dockerDaemonProbe: @escaping @Sendable () -> Bool = { true }
    ) -> (LifecycleService, PersistedSpawnStore) {
        let store = PersistedSpawnStore(stateFile: stateFile)
        let lifecycle = LifecycleService(
            lookupService: { id in id == service.id ? service : nil },
            spawnStore: store,
            dockerDaemonProbe: dockerDaemonProbe
        )
        return (lifecycle, store)
    }

    // MARK: - Project lifecycle

    func testProjectStart_writesPersistedSpawn() async throws {
        let name = uniqueProjectName("start")
        let svc = projectService(
            name: name,
            path: FileManager.default.temporaryDirectory,
            command: "/bin/sh -c 'sleep 30'"
        )
        let stateFile = tempStateFile()
        defer { try? FileManager.default.removeItem(at: stateFile) }
        let (lifecycle, store) = makeService(for: svc, stateFile: stateFile)

        try await lifecycle.start(serviceID: svc.id)

        let spawns = store.spawns()
        XCTAssertEqual(spawns.count, 1, "expected one persisted spawn after start")
        let spawn = try XCTUnwrap(spawns.first)
        XCTAssertEqual(spawn.serviceID, svc.id)
        XCTAssertTrue(LifecycleSupervisor.isAlive(pid: spawn.pid), "spawned PID should be alive")

        // Cleanup the child so the test doesn't leak a sleeping process.
        _ = LifecycleSupervisor.forceKill(pid: spawn.pid)
        for _ in 0..<20 {
            tryReap(spawn.pid)
            if !LifecycleSupervisor.isAlive(pid: spawn.pid) { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    func testProjectStop_removesPersistedSpawn() async throws {
        let name = uniqueProjectName("stop")
        let svc = projectService(
            name: name,
            path: FileManager.default.temporaryDirectory,
            command: "/bin/sh -c 'sleep 30'"
        )
        let stateFile = tempStateFile()
        defer { try? FileManager.default.removeItem(at: stateFile) }
        let store = PersistedSpawnStore(stateFile: stateFile)

        // After start, the lookup needs to report the service as .running so
        // stop() takes the right code path. Rebuild the lifecycle with a
        // fresh closure once we know the PID.
        let starter = LifecycleService(
            lookupService: { id in id == svc.id ? svc : nil },
            spawnStore: store,
            dockerDaemonProbe: { true }
        )
        try await starter.start(serviceID: svc.id)
        let spawnedPID = try XCTUnwrap(store.spawns().first?.pid)

        let runningSvc = projectService(
            name: name,
            path: FileManager.default.temporaryDirectory,
            command: "/bin/sh -c 'sleep 30'",
            state: .running(pid: spawnedPID, since: Date())
        )
        let stopper = LifecycleService(
            lookupService: { id in id == runningSvc.id ? runningSvc : nil },
            spawnStore: store,
            dockerDaemonProbe: { true }
        )
        try await stopper.stop(serviceID: runningSvc.id)

        XCTAssertEqual(store.spawns(), [], "stop should remove the persisted spawn")
        // Reap so isAlive can settle, then assert.
        for _ in 0..<20 {
            tryReap(spawnedPID)
            if !LifecycleSupervisor.isAlive(pid: spawnedPID) { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertFalse(LifecycleSupervisor.isAlive(pid: spawnedPID), "stopped PID should be dead")
    }

    func testProjectKill_removesPersistedSpawn() async throws {
        let name = uniqueProjectName("kill")
        let svc = projectService(
            name: name,
            path: FileManager.default.temporaryDirectory,
            command: "/bin/sh -c 'sleep 30'"
        )
        let stateFile = tempStateFile()
        defer { try? FileManager.default.removeItem(at: stateFile) }
        let store = PersistedSpawnStore(stateFile: stateFile)

        let starter = LifecycleService(
            lookupService: { id in id == svc.id ? svc : nil },
            spawnStore: store,
            dockerDaemonProbe: { true }
        )
        try await starter.start(serviceID: svc.id)
        let spawnedPID = try XCTUnwrap(store.spawns().first?.pid)

        let runningSvc = projectService(
            name: name,
            path: FileManager.default.temporaryDirectory,
            command: "/bin/sh -c 'sleep 30'",
            state: .running(pid: spawnedPID, since: Date())
        )
        let killer = LifecycleService(
            lookupService: { id in id == runningSvc.id ? runningSvc : nil },
            spawnStore: store,
            dockerDaemonProbe: { true }
        )
        try await killer.kill(serviceID: runningSvc.id)

        XCTAssertEqual(store.spawns(), [], "kill should remove the persisted spawn")
        for _ in 0..<20 {
            tryReap(spawnedPID)
            if !LifecycleSupervisor.isAlive(pid: spawnedPID) { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertFalse(LifecycleSupervisor.isAlive(pid: spawnedPID), "killed PID should be dead")
    }

    func testLaunchWatcher_capturesQuickExit() async throws {
        let name = uniqueProjectName("quickexit")
        // `echo boom && exit 7` — should die before the 10s watch deadline,
        // so the watcher records a LaunchFailure and prunes the spawn.
        let svc = projectService(
            name: name,
            path: FileManager.default.temporaryDirectory,
            command: "/bin/sh -c 'echo boom && exit 7'"
        )
        let stateFile = tempStateFile()
        defer { try? FileManager.default.removeItem(at: stateFile) }
        let (lifecycle, store) = makeService(for: svc, stateFile: stateFile)

        try await lifecycle.start(serviceID: svc.id)
        // The child exits more or less immediately, but we still need to
        // reap it in-process so the watcher's `isAlive` returns false. Poll
        // alongside the watcher's own polling loop.
        var failure: LaunchFailure?
        for _ in 0..<30 {
            if let pid = store.spawns().first?.pid { tryReap(pid) }
            if let f = lifecycle.listLaunchFailures()[svc.id] {
                failure = f; break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let f = try XCTUnwrap(failure, "launch watcher should have recorded a failure within 3s")
        XCTAssertTrue(f.logTail.contains("boom"), "log tail should capture stdout: \(f.logTail)")
        XCTAssertTrue(
            f.summary.contains("exited after") && f.summary.contains("boom"),
            "summary should mention alive-time and last line: \(f.summary)"
        )
        XCTAssertEqual(store.spawns(), [], "watcher should prune the dead spawn record")
    }

    func testProjectStart_pathNotFound_throwsAndLogs() async throws {
        let name = uniqueProjectName("badpath")
        let bogus = FileManager.default.temporaryDirectory
            .appendingPathComponent("does-not-exist-\(UUID().uuidString)")
        let svc = projectService(
            name: name,
            path: bogus,
            command: "/bin/sh -c 'true'"
        )
        let stateFile = tempStateFile()
        defer { try? FileManager.default.removeItem(at: stateFile) }
        let (lifecycle, store) = makeService(for: svc, stateFile: stateFile)

        do {
            try await lifecycle.start(serviceID: svc.id)
            XCTFail("expected start to throw for missing path")
        } catch let RPCError.invalidParams(msg) {
            XCTAssertTrue(msg.contains("path not found"), "error message should mention path not found: \(msg)")
        } catch {
            XCTFail("expected RPCError.invalidParams, got \(error)")
        }

        XCTAssertEqual(store.spawns(), [], "no spawn should be persisted when preflight fails")

        // Assert the preflight log line was written.
        let logURL = CorePaths.logFile(for: svc.id)
        defer { try? FileManager.default.removeItem(at: logURL) }
        let contents = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
        XCTAssertTrue(
            contents.contains("[matisa] path not found:"),
            "log file should contain the preflight diagnostic line; got: \(contents)"
        )
    }

    // MARK: - Error mapping

    func testUnknownServiceID_throwsInvalidParams() async {
        let stateFile = tempStateFile()
        defer { try? FileManager.default.removeItem(at: stateFile) }
        let store = PersistedSpawnStore(stateFile: stateFile)
        let lifecycle = LifecycleService(
            lookupService: { _ in nil },
            spawnStore: store,
            dockerDaemonProbe: { true }
        )
        do {
            try await lifecycle.start(serviceID: "project:nonexistent")
            XCTFail("expected start on unknown service to throw")
        } catch let RPCError.invalidParams(msg) {
            XCTAssertTrue(msg.contains("unknown service"), "expected invalidParams about unknown service: \(msg)")
        } catch {
            XCTFail("expected RPCError.invalidParams, got \(error)")
        }
    }

    // MARK: - Launch-failure tracker

    func testListAndClearLaunchFailures_roundTrip() {
        let stateFile = tempStateFile()
        defer { try? FileManager.default.removeItem(at: stateFile) }
        let store = PersistedSpawnStore(stateFile: stateFile)
        let lifecycle = LifecycleService(
            lookupService: { _ in nil },
            spawnStore: store,
            dockerDaemonProbe: { true }
        )

        // Empty by default.
        XCTAssertEqual(lifecycle.listLaunchFailures(), [:])

        // Clearing an unknown id is a no-op.
        lifecycle.clearLaunchFailure(serviceID: "project:nope")
        XCTAssertEqual(lifecycle.listLaunchFailures(), [:])
    }

    // MARK: - deadSpawnIDs cleanup via ServicesService

    /// `ServicesService.snapshot()` is the authoritative cleanup point for
    /// stale persisted spawns (Phase 2c.2). This test seeds a spawn whose
    /// PID is dead and matches a configured project service; the snapshot
    /// call should prune it from disk.
    ///
    /// Uses a fixture services.ts and a real `ConfigService` so the merge
    /// path is exercised end-to-end. Skips if bun isn't available — same
    /// constraint the engine has at runtime.
    func testServicesSnapshot_prunesDeadSpawn() async throws {
        let bunPaths = [
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
            FileManager.default.homeDirectoryForCurrentUser.path + "/.bun/bin/bun",
            FileManager.default.homeDirectoryForCurrentUser.path + "/.local/bin/bun",
        ]
        guard bunPaths.contains(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw XCTSkip("bun not installed; deadSpawnIDs cleanup test needs config eval")
        }

        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("matisa-snapshot-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let projectPath = tmpDir.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: projectPath, withIntermediateDirectories: true)

        let configURL = tmpDir.appendingPathComponent("services.ts")
        let projectName = "ghost"
        let configSource = """
        export default {
          services: [
            {
              type: "project",
              name: "\(projectName)",
              path: "\(projectPath.path)",
              port: 65432,
              command: "true"
            }
          ]
        };
        """
        try configSource.write(to: configURL, atomically: true, encoding: .utf8)

        let stateFile = tmpDir.appendingPathComponent("state.json")
        let spawnStore = PersistedSpawnStore(stateFile: stateFile)
        // Highly-unlikely-to-be-live PID. The merge will see no listening
        // port (65432 is unused) and no live spawn (99999 is dead), so it
        // adds the id to deadSpawnIDs and snapshot() prunes it.
        let serviceID = "project:\(projectName)"
        spawnStore.upsert(PersistedSpawn(
            serviceID: serviceID,
            pid: 99999,
            port: 65432,
            startedAt: Date(timeIntervalSinceNow: -60),
            logPath: "/tmp/ghost.log"
        ))
        XCTAssertEqual(spawnStore.spawns().map(\.serviceID), [serviceID])

        let configService = ConfigService(configPath: configURL.path)
        let services = ServicesService(
            configService: configService,
            discoveryService: DiscoveryService(),
            spawnStore: spawnStore
        )

        _ = try services.snapshot()
        XCTAssertEqual(spawnStore.spawns(), [], "snapshot should prune the dead spawn record")
    }
}
