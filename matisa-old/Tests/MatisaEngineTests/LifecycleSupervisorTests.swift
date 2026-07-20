import XCTest
import Darwin
import MatisaCore
@testable import MatisaEngine

/// Smoke tests for the engine's process supervisor. We avoid mocking
/// `posix_spawn` and instead exercise the real syscall path against `/bin/sh`
/// — anything weaker wouldn't catch the kinds of bugs (wrong fd dup2, wrong
/// session-leader flag, signal-to-wrong-target) we actually care about.
///
/// Each test uses a unique serviceID so the log file path doesn't collide
/// with sibling tests or leftover state from a previous run.
///
/// Note on zombies: `posix_spawn` from the test process keeps the test as
/// the child's parent. Once the child exits it becomes a zombie until
/// reaped, and a zombie still answers `kill(pid, 0) == 0` (i.e. "alive").
/// In production the engine reaps via the OS signal handler / orphan
/// path, but in-process we need to call `waitpid` ourselves before the
/// `isAlive` check can return false. The tests poll `waitpid` with
/// WNOHANG alongside `isAlive` to model that.
final class LifecycleSupervisorTests: XCTestCase {

    private func uniqueServiceID(_ tag: String) -> String {
        "matisa-test:\(tag)-\(UUID().uuidString.prefix(8))"
    }

    /// Reap an exited child (if any) so subsequent `isAlive` calls return
    /// false. Returns true once the pid has been reaped or is otherwise gone.
    @discardableResult
    private func tryReap(_ pid: pid_t) -> Bool {
        var status: Int32 = 0
        let rc = waitpid(pid, &status, WNOHANG)
        // rc > 0: reaped. rc == 0: still running. rc < 0: error (likely ECHILD).
        return rc != 0
    }

    func testSpawn_capturesStdoutToLog() async throws {
        let id = uniqueServiceID("stdout")
        let cwd = FileManager.default.temporaryDirectory
        let result = try LifecycleSupervisor.spawnDetached(
            shellCommand: "/bin/sh -c 'echo hello-from-test'",
            workingDirectory: cwd,
            serviceID: id
        )
        defer { try? FileManager.default.removeItem(at: result.logURL) }

        // Give the child a moment to write + exit. 200ms is generous for
        // `echo` but cheap if it returns sooner.
        try await Task.sleep(nanoseconds: 200_000_000)
        // Re-poll in case CI is slow.
        var contents = ""
        for _ in 0..<20 {
            contents = (try? String(contentsOf: result.logURL, encoding: .utf8)) ?? ""
            if contents.contains("hello-from-test") { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(
            contents.contains("hello-from-test"),
            "expected stdout in log file; got: \(contents)"
        )
        XCTAssertEqual(result.logURL, CorePaths.logFile(for: id))
    }

    func testIsAlive_transitionsCorrectly() async throws {
        let id = uniqueServiceID("alive")
        let cwd = FileManager.default.temporaryDirectory
        let result = try LifecycleSupervisor.spawnDetached(
            shellCommand: "/bin/sh -c 'sleep 0.5'",
            workingDirectory: cwd,
            serviceID: id
        )
        defer { try? FileManager.default.removeItem(at: result.logURL) }

        XCTAssertTrue(LifecycleSupervisor.isAlive(pid: result.pid), "child should be alive immediately after spawn")

        // Wait past the child's natural exit. Poll rather than a single
        // sleep so a slow scheduler doesn't make this flaky. We reap on
        // every loop iteration so the zombie doesn't keep `isAlive` true.
        var died = false
        for _ in 0..<30 {
            try await Task.sleep(nanoseconds: 100_000_000)
            tryReap(result.pid)
            if !LifecycleSupervisor.isAlive(pid: result.pid) {
                died = true
                break
            }
        }
        XCTAssertTrue(died, "child should have exited within ~3s")
    }

    func testStopWithEscalation_killsRunningChild() async throws {
        let id = uniqueServiceID("escalate")
        let cwd = FileManager.default.temporaryDirectory
        let result = try LifecycleSupervisor.spawnDetached(
            shellCommand: "/bin/sh -c 'sleep 60'",
            workingDirectory: cwd,
            serviceID: id
        )
        defer { try? FileManager.default.removeItem(at: result.logURL) }

        XCTAssertTrue(LifecycleSupervisor.isAlive(pid: result.pid))

        await LifecycleSupervisor.stopWithEscalation(pid: result.pid, gracefulSeconds: 1)

        // After SIGTERM and (potentially) SIGKILL the process group should
        // be gone. Reap on every poll iteration so the zombie can clear.
        var died = false
        for _ in 0..<30 {
            tryReap(result.pid)
            if !LifecycleSupervisor.isAlive(pid: result.pid) {
                died = true
                break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(died, "stopWithEscalation should have killed the sleep child")
    }
}
