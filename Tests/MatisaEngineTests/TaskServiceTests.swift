import XCTest
import Darwin
import MatisaCore
@testable import MatisaEngine

/// Exercises the engine's ad-hoc task runner end-to-end against a real
/// `Foundation.Process` — the same boundary the runner uses in production.
/// Each test uses a unique service id so the per-(serviceID, kind) slot map
/// stays isolated across runs.
final class TaskServiceTests: XCTestCase {

    private let tmp = FileManager.default.temporaryDirectory

    private func uniqueID(_ tag: String) -> String {
        "project:tasksvc-\(tag)-\(UUID().uuidString.prefix(8))"
    }

    /// Poll the slot until `predicate` is true or the deadline elapses.
    /// Returns the last-seen slot. Uses short sleeps so termination handlers
    /// running on Foundation worker threads have time to land on the queue.
    @discardableResult
    private func waitForSlot(
        _ svc: TaskService,
        id: String,
        kind: TaskKind,
        timeout: TimeInterval = 5.0,
        until predicate: (TaskSlot) -> Bool
    ) async -> TaskSlot {
        let deadline = Date().addingTimeInterval(timeout)
        var last = TaskSlot(state: .idle, buffer: "")
        while Date() < deadline {
            last = svc.list(serviceID: id)[kind] ?? TaskSlot(state: .idle, buffer: "")
            if predicate(last) { return last }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return last
    }

    func testStart_runsCommand_andCapturesOutput() async throws {
        let svc = TaskService()
        let id = uniqueID("echo")
        svc.start(
            serviceID: id, kind: .build, name: "echo",
            command: "echo hello", cwd: tmp, extraEnv: [:]
        )
        let final = await waitForSlot(svc, id: id, kind: .build) {
            if case .exited = $0.state { return true }
            return false
        }
        guard case let .exited(name, code, _) = final.state else {
            return XCTFail("expected .exited, got \(final.state)")
        }
        XCTAssertEqual(name, "echo")
        XCTAssertEqual(code, 0)
        XCTAssertTrue(final.buffer.contains("hello"), "buffer should include 'hello', got: \(final.buffer)")
    }

    func testStart_whileAlreadyRunning_isNoOp() async throws {
        let svc = TaskService()
        let id = uniqueID("dup")
        // Long sleeper — gives us a steady "running" state to attempt a
        // second start against.
        svc.start(
            serviceID: id, kind: .build, name: "first",
            command: "sleep 5", cwd: tmp, extraEnv: [:]
        )
        // Confirm the first one landed and is running.
        let firstSlot = await waitForSlot(svc, id: id, kind: .build) { $0.state.isRunning }
        guard case .running(let firstName, _) = firstSlot.state else {
            return XCTFail("expected .running, got \(firstSlot.state)")
        }
        XCTAssertEqual(firstName, "first")

        // Second start with a different name — should be silently dropped.
        svc.start(
            serviceID: id, kind: .build, name: "second",
            command: "sleep 5", cwd: tmp, extraEnv: [:]
        )
        // Slot should still report the first task running.
        let after = svc.list(serviceID: id)[.build]
        guard case .running(let name, _) = after?.state else {
            return XCTFail("expected still .running, got \(String(describing: after?.state))")
        }
        XCTAssertEqual(name, "first", "second start should not have replaced the first")

        svc.cancel(serviceID: id, kind: .build)
        _ = await waitForSlot(svc, id: id, kind: .build) {
            if case .exited = $0.state { return true }
            return false
        }
    }

    func testCancel_killsRunningTask() async throws {
        let svc = TaskService()
        let id = uniqueID("cancel")
        svc.start(
            serviceID: id, kind: .build, name: "sleeper",
            command: "sleep 30", cwd: tmp, extraEnv: [:]
        )
        _ = await waitForSlot(svc, id: id, kind: .build) { $0.state.isRunning }
        svc.cancel(serviceID: id, kind: .build)
        let final = await waitForSlot(svc, id: id, kind: .build) {
            if case .exited = $0.state { return true }
            return false
        }
        guard case let .exited(_, code, _) = final.state else {
            return XCTFail("expected .exited, got \(final.state)")
        }
        // SIGTERM-cancelled shells exit with a nonzero code (typically 143
        // on Darwin, or sometimes the signal number itself). Just assert it
        // wasn't a clean zero exit.
        XCTAssertNotEqual(code, 0, "cancelled task should not exit 0")
    }

    func testClear_wipesBufferLeavesStateRunning() async throws {
        let svc = TaskService()
        let id = uniqueID("clear")
        // A sleeper that emits one line then sleeps. Lets us catch some output
        // before we clear, then verify the state didn't change. The whole
        // pipeline is wrapped in `sh -c` because the engine's launcher does
        // `exec <command>` — without the wrapper, the shell would `exec echo`
        // and never reach `sleep`.
        svc.start(
            serviceID: id, kind: .build, name: "chatty",
            command: "sh -c 'echo hi; sleep 30'", cwd: tmp, extraEnv: [:]
        )
        _ = await waitForSlot(svc, id: id, kind: .build) { slot in
            slot.state.isRunning && slot.buffer.contains("hi")
        }
        svc.clear(serviceID: id, kind: .build)
        let cleared = try XCTUnwrap(svc.list(serviceID: id)[.build])
        XCTAssertEqual(cleared.buffer, "", "buffer should be empty after clear")
        XCTAssertTrue(cleared.state.isRunning, "clear must not affect state")
        svc.cancel(serviceID: id, kind: .build)
        _ = await waitForSlot(svc, id: id, kind: .build) {
            if case .exited = $0.state { return true }
            return false
        }
    }

    func testClosePane_whileRunning_isNoOp() async throws {
        let svc = TaskService()
        let id = uniqueID("close-running")
        svc.start(
            serviceID: id, kind: .build, name: "sleeper",
            command: "sleep 30", cwd: tmp, extraEnv: [:]
        )
        _ = await waitForSlot(svc, id: id, kind: .build) { $0.state.isRunning }
        svc.closePane(serviceID: id, kind: .build)
        let after = try XCTUnwrap(svc.list(serviceID: id)[.build])
        XCTAssertTrue(after.state.isRunning, "closePane on a running slot must be a no-op")
        svc.cancel(serviceID: id, kind: .build)
        _ = await waitForSlot(svc, id: id, kind: .build) {
            if case .exited = $0.state { return true }
            return false
        }
    }

    func testClosePane_whenExited_resetsToIdle() async throws {
        let svc = TaskService()
        let id = uniqueID("close-exited")
        svc.start(
            serviceID: id, kind: .script, name: "echo",
            command: "echo done", cwd: tmp, extraEnv: [:]
        )
        _ = await waitForSlot(svc, id: id, kind: .script) {
            if case .exited = $0.state { return true }
            return false
        }
        svc.closePane(serviceID: id, kind: .script)
        // closePane drops the slot from the map entirely — `list` returns an
        // empty dict for the service. The app's `replaceSlotsFromEngine`
        // treats an absent kind the same way it treats `.idle`: the pane
        // disappears.
        XCTAssertNil(svc.list(serviceID: id)[.script])
    }

    func testList_returnsEmptyForUnknownService() {
        let svc = TaskService()
        XCTAssertEqual(svc.list(serviceID: "project:unknown"), [:])
    }
}
