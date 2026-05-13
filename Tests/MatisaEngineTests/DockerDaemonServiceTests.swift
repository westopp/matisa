import XCTest
import MatisaCore
@testable import MatisaEngine

/// Tests the engine's Docker daemon state machine. The injectable
/// `daemonProbe` / `openDocker` / `quitDocker` seams let us exercise the
/// state transitions without touching a real Docker install — the actual
/// shell-outs (`EngineShell.run`) are exempted from coverage by design.
final class DockerDaemonServiceTests: XCTestCase {

    // MARK: - Helpers

    /// Poll `condition` every 10ms up to `timeout`. Returns true if it ever
    /// holds. Used for the transitions that resolve on a background Task —
    /// the queue mutation lands a moment after the trigger returns.
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

    // MARK: - Initial state

    func testInitialState_isUnknown() {
        let svc = DockerDaemonService(
            daemonProbe: { false },
            openDocker: {},
            quitDocker: {}
        )
        XCTAssertEqual(svc.status(), .unknown)
    }

    // MARK: - clearFailure

    /// `.startFailed → .stopped` is the positive arm of clearFailure. Drive
    /// the service into `.startFailed` quickly by injecting a tight
    /// `readyTimeout` and `pollIntervalNS` plus a probe that never returns
    /// true — same shape as production but completes in tens of ms.
    func testClearFailure_fromStartFailed_movesToStopped() async {
        let svc = DockerDaemonService(
            daemonProbe: { false },             // never ready → timeout path
            openDocker: {},
            quitDocker: {},
            readyTimeout: 0.05,                 // 50ms total deadline
            pollIntervalNS: 10_000_000          // 10ms poll
        )
        await svc.start()
        XCTAssertTrue(waitUntil { svc.status().isStartFailed })

        svc.clearFailure()
        XCTAssertEqual(svc.status(), .stopped)
    }

    func testClearFailure_fromHealthyStates_isNoOp() async {
        let svc = DockerDaemonService(
            daemonProbe: { true },
            openDocker: {},
            quitDocker: {}
        )
        // .unknown → clearFailure is no-op
        svc.clearFailure()
        XCTAssertEqual(svc.status(), .unknown)

        // Bring up to .running via start with a probe that succeeds
        // immediately.
        await svc.start()
        XCTAssertTrue(waitUntil { svc.status() == .running })

        // clearFailure from .running is a no-op.
        svc.clearFailure()
        XCTAssertEqual(svc.status(), .running)
    }

    /// Same predicate exercised from the other "non-startFailed" states the
    /// service can reach without paying the full timeout: `.starting` and
    /// `.stopped`.
    func testClearFailure_fromOtherStates_isNoOp() async {
        // .stopped is reached via cancelStart from .starting.
        let neverReady = DockerDaemonService(
            daemonProbe: { false },
            openDocker: { try? await Task.sleep(nanoseconds: 50_000_000) },
            quitDocker: {}
        )
        await neverReady.start()
        XCTAssertTrue(waitUntil { neverReady.status() == .starting })

        neverReady.cancelStart()
        XCTAssertEqual(neverReady.status(), .stopped)

        // clearFailure from .stopped — no-op.
        neverReady.clearFailure()
        XCTAssertEqual(neverReady.status(), .stopped)

        // clearFailure from .starting — no-op (start a fresh one).
        let alsoNever = DockerDaemonService(
            daemonProbe: { false },
            openDocker: { try? await Task.sleep(nanoseconds: 50_000_000) },
            quitDocker: {}
        )
        await alsoNever.start()
        XCTAssertTrue(waitUntil { alsoNever.status() == .starting })

        alsoNever.clearFailure()
        XCTAssertEqual(alsoNever.status(), .starting)

        // Clean up the in-flight task.
        alsoNever.cancelStart()
    }

    // MARK: - cancelStart

    func testCancelStart_whileStarting_movesToStopped() async {
        let openExpect = XCTestExpectation(description: "openDocker called")
        let quitExpect = XCTestExpectation(description: "quitDocker called")
        let svc = DockerDaemonService(
            daemonProbe: { false },             // never ready
            openDocker: {
                openExpect.fulfill()
                // Hold long enough that the cancel arrives mid-poll.
                try? await Task.sleep(nanoseconds: 100_000_000)
            },
            quitDocker: { quitExpect.fulfill() }
        )

        await svc.start()
        XCTAssertTrue(waitUntil { svc.status() == .starting })
        await fulfillment(of: [openExpect], timeout: 1)

        svc.cancelStart()
        XCTAssertEqual(svc.status(), .stopped)

        // cancelStart fires quitDocker in a detached Task — give it a moment.
        await fulfillment(of: [quitExpect], timeout: 1)
    }

    func testCancelStart_whileNotStarting_isNoOp() {
        let svc = DockerDaemonService(
            daemonProbe: { true },
            openDocker: {},
            quitDocker: {}
        )
        // From .unknown
        svc.cancelStart()
        XCTAssertEqual(svc.status(), .unknown)
    }

    // MARK: - Concurrent start()

    /// Two rapid-fire `start()` calls must only dispatch one underlying
    /// `open -a Docker`. Matches the app's
    /// `guard !dockerSystem.isStarting else { return }` semantics.
    /// Regression for F-001 in the 2f review: an immediate `cancelStart()`
    /// fired right after `start()` returns must actually cancel the in-flight
    /// task and produce a terminal `.stopped`, not let the finishStart write
    /// race in and stomp with `.running`/`.startFailed`. Pre-fix, the
    /// two-stage queue.sync in start() created a window where startTask was
    /// still nil when cancelStart read state, so the cancel bailed silently.
    func testCancelStart_immediatelyAfterStart_endsAtStopped() async {
        let svc = DockerDaemonService(
            daemonProbe: { false },             // would otherwise time out → .startFailed
            openDocker: { try? await Task.sleep(nanoseconds: 50_000_000) },
            quitDocker: {},
            readyTimeout: 0.1,                  // short so a lost cancel surfaces fast
            pollIntervalNS: 10_000_000
        )
        await svc.start()
        svc.cancelStart()
        // Immediate observation: cancel writes .stopped synchronously.
        XCTAssertEqual(svc.status(), .stopped)
        // And it stays .stopped — finishStart must NOT race in and overwrite.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(svc.status(), .stopped)
    }

    func testConcurrentStart_onlyOneOpenCall() async {
        let openCount = Counter()
        let svc = DockerDaemonService(
            daemonProbe: { false },             // keep .starting
            openDocker: {
                openCount.increment()
                try? await Task.sleep(nanoseconds: 100_000_000)
            },
            quitDocker: {}
        )

        // Kick off two concurrent starts.
        async let a: Void = svc.start()
        async let b: Void = svc.start()
        _ = await (a, b)

        XCTAssertTrue(waitUntil { svc.status() == .starting })
        // Give the openDocker tasks time to run to completion (they only
        // sleep 100ms).
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(openCount.value, 1)

        svc.cancelStart()
    }

    // MARK: - Successful start

    func testStart_withReadyProbe_transitionsToRunning() async {
        let svc = DockerDaemonService(
            daemonProbe: { true },              // ready immediately
            openDocker: {},
            quitDocker: {}
        )
        await svc.start()
        XCTAssertTrue(waitUntil { svc.status() == .running })
    }
}

/// Tiny thread-safe counter for use in concurrent-call tests. Avoids
/// pulling in `os.Lock` or `NSLock` for one int.
private final class Counter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "test.counter")
    private var _value: Int = 0
    func increment() { queue.sync { _value += 1 } }
    var value: Int { queue.sync { _value } }
}
