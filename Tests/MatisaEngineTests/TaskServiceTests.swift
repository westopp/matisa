import XCTest
import Darwin
import MatisaCore
@testable import MatisaEngine

/// Exercises the engine's ad-hoc command runner end-to-end against a real
/// `Foundation.Process` — the same boundary the runner uses in production.
/// Each test uses a unique service id so the per-(serviceID, name) slot map
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
        name: String,
        timeout: TimeInterval = 5.0,
        until predicate: (TaskSlot) -> Bool
    ) async -> TaskSlot {
        let deadline = Date().addingTimeInterval(timeout)
        var last = TaskSlot(state: .idle, buffer: "")
        while Date() < deadline {
            last = svc.list(serviceID: id)[name] ?? TaskSlot(state: .idle, buffer: "")
            if predicate(last) { return last }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return last
    }

    func testStart_runsCommand_andCapturesOutput() async throws {
        let svc = TaskService()
        let id = uniqueID("echo")
        svc.start(
            serviceID: id, name: "echo",
            command: "echo hello", cwd: tmp, extraEnv: [:]
        )
        let final = await waitForSlot(svc, id: id, name: "echo") {
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

    func testStart_sameName_whileAlreadyRunning_isNoOp() async throws {
        let svc = TaskService()
        let id = uniqueID("dup")
        // Long sleeper — gives us a steady "running" state to attempt a
        // second same-name start against.
        svc.start(
            serviceID: id, name: "build",
            command: "sleep 5", cwd: tmp, extraEnv: [:]
        )
        let firstSlot = await waitForSlot(svc, id: id, name: "build") { $0.state.isRunning }
        guard case .running(let firstName, let firstSince) = firstSlot.state else {
            return XCTFail("expected .running, got \(firstSlot.state)")
        }
        XCTAssertEqual(firstName, "build")

        // Second start with the same name — should be silently dropped.
        // We re-issue with a longer sleep so a successful start would
        // visibly extend the slot lifetime; the same-name guard should
        // prevent it. We compare `since:` to verify nothing reset.
        svc.start(
            serviceID: id, name: "build",
            command: "sleep 30", cwd: tmp, extraEnv: [:]
        )
        let after = svc.list(serviceID: id)["build"]
        guard case .running(_, let sinceAfter) = after?.state else {
            return XCTFail("expected still .running, got \(String(describing: after?.state))")
        }
        XCTAssertEqual(sinceAfter, firstSince, "same-name re-start should not have replaced the running slot")

        svc.cancel(serviceID: id, name: "build")
        _ = await waitForSlot(svc, id: id, name: "build") {
            if case .exited = $0.state { return true }
            return false
        }
    }

    /// Two different command names can run simultaneously — concurrency cap
    /// is `TaskLimits.maxRunningCommands` (2), not 1.
    func testStart_differentNames_canRunConcurrently() async throws {
        let svc = TaskService()
        let id = uniqueID("concurrent")
        svc.start(serviceID: id, name: "a", command: "sleep 30", cwd: tmp, extraEnv: [:])
        svc.start(serviceID: id, name: "b", command: "sleep 30", cwd: tmp, extraEnv: [:])

        let slotA = await waitForSlot(svc, id: id, name: "a") { $0.state.isRunning }
        let slotB = await waitForSlot(svc, id: id, name: "b") { $0.state.isRunning }
        XCTAssertTrue(slotA.state.isRunning)
        XCTAssertTrue(slotB.state.isRunning)

        svc.cancel(serviceID: id, name: "a")
        svc.cancel(serviceID: id, name: "b")
    }

    /// Hitting the per-service cap silently drops the third start.
    func testStart_atRunningCap_dropsThirdStart() async throws {
        let svc = TaskService()
        let id = uniqueID("cap")
        svc.start(serviceID: id, name: "a", command: "sleep 30", cwd: tmp, extraEnv: [:])
        svc.start(serviceID: id, name: "b", command: "sleep 30", cwd: tmp, extraEnv: [:])
        _ = await waitForSlot(svc, id: id, name: "a") { $0.state.isRunning }
        _ = await waitForSlot(svc, id: id, name: "b") { $0.state.isRunning }

        // Third start should be silently dropped — the slot for "c" must
        // never appear in the list.
        svc.start(serviceID: id, name: "c", command: "sleep 30", cwd: tmp, extraEnv: [:])
        // Give the engine a tick to (correctly) decide not to spawn.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(svc.list(serviceID: id)["c"], "third start beyond the cap must not create a slot")
        XCTAssertEqual(
            svc.list(serviceID: id).values.filter { $0.state.isRunning }.count,
            TaskLimits.maxRunningCommands
        )

        svc.cancel(serviceID: id, name: "a")
        svc.cancel(serviceID: id, name: "b")
    }

    func testCancel_killsRunningTask() async throws {
        let svc = TaskService()
        let id = uniqueID("cancel")
        svc.start(
            serviceID: id, name: "sleeper",
            command: "sleep 30", cwd: tmp, extraEnv: [:]
        )
        _ = await waitForSlot(svc, id: id, name: "sleeper") { $0.state.isRunning }
        svc.cancel(serviceID: id, name: "sleeper")
        let final = await waitForSlot(svc, id: id, name: "sleeper") {
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
            serviceID: id, name: "chatty",
            command: "sh -c 'echo hi; sleep 30'", cwd: tmp, extraEnv: [:]
        )
        _ = await waitForSlot(svc, id: id, name: "chatty") { slot in
            slot.state.isRunning && slot.buffer.contains("hi")
        }
        svc.clear(serviceID: id, name: "chatty")
        let cleared = try XCTUnwrap(svc.list(serviceID: id)["chatty"])
        XCTAssertEqual(cleared.buffer, "", "buffer should be empty after clear")
        XCTAssertTrue(cleared.state.isRunning, "clear must not affect state")
        svc.cancel(serviceID: id, name: "chatty")
        _ = await waitForSlot(svc, id: id, name: "chatty") {
            if case .exited = $0.state { return true }
            return false
        }
    }

    func testClosePane_whileRunning_isNoOp() async throws {
        let svc = TaskService()
        let id = uniqueID("close-running")
        svc.start(
            serviceID: id, name: "sleeper",
            command: "sleep 30", cwd: tmp, extraEnv: [:]
        )
        _ = await waitForSlot(svc, id: id, name: "sleeper") { $0.state.isRunning }
        svc.closePane(serviceID: id, name: "sleeper")
        let after = try XCTUnwrap(svc.list(serviceID: id)["sleeper"])
        XCTAssertTrue(after.state.isRunning, "closePane on a running slot must be a no-op")
        svc.cancel(serviceID: id, name: "sleeper")
        _ = await waitForSlot(svc, id: id, name: "sleeper") {
            if case .exited = $0.state { return true }
            return false
        }
    }

    func testClosePane_whenExited_resetsToIdle() async throws {
        let svc = TaskService()
        let id = uniqueID("close-exited")
        svc.start(
            serviceID: id, name: "echo",
            command: "echo done", cwd: tmp, extraEnv: [:]
        )
        _ = await waitForSlot(svc, id: id, name: "echo") {
            if case .exited = $0.state { return true }
            return false
        }
        svc.closePane(serviceID: id, name: "echo")
        // closePane drops the slot from the map entirely — `list` returns an
        // empty dict for the service. The app's `replaceSlotsFromEngine`
        // treats an absent name the same way it treats `.idle`: the pane
        // disappears.
        XCTAssertNil(svc.list(serviceID: id)["echo"])
    }

    func testList_returnsEmptyForUnknownService() {
        let svc = TaskService()
        XCTAssertEqual(svc.list(serviceID: "project:unknown"), [:])
    }
}
