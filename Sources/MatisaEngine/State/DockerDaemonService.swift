import Foundation
import MatisaCore

/// Engine-side owner of the Docker Desktop lifecycle state machine. Replaces
/// the app's `DockerProbe.startDockerDesktop` / `stopDockerDesktop` /
/// `awaitDaemonReady` orchestration plus the `dockerSystem` field on
/// `ServiceStore`. The app keeps the UI bits (the "Starting Docker Desktop…"
/// sheet, `pendingDockerPrompt`) and mirrors this service's state during
/// each refresh tick.
///
/// State transitions:
///   .unknown / .stopped / .startFailed → start() → .starting → (await daemon)
///   .starting --(daemon up)→ .running
///   .starting --(timeout)→ .startFailed("Docker didn't come up in time")
///   .starting --(cancel_start)→ .stopped  (also fires a graceful quit)
///   .running --(stop)→ .stopped
///   .startFailed --(clear_failure)→ .stopped
///
/// Thread-safety: state and the in-flight Task handle live behind a serial
/// `DispatchQueue`. RPC handlers (which arrive on the engine's worker queue)
/// call `status()` synchronously and the action methods (`start`, `stop`,
/// `cancelStart`, `clearFailure`) are `async`/sync — they all funnel through
/// the queue for mutation.
///
/// Concurrent `start()` is a no-op: if state is already `.starting`, the
/// second caller returns immediately without dispatching a second `open`.
/// Mirrors the app's `ServiceStore.performDockerStart` guard.
final class DockerDaemonService: @unchecked Sendable {

    /// Default poll interval inside `awaitDaemonReady`. Match the app's value
    /// so the engine-driven path feels identical to the local one.
    private static let pollIntervalNS: UInt64 = 1_000_000_000   // 1s

    /// Default deadline for the poll loop. Same 60s the app uses today.
    private static let readyTimeout: TimeInterval = 60

    /// Per-probe timeout passed to the daemon check. 2s is the app's value.
    private static let probeTimeout: TimeInterval = 2

    private let queue = DispatchQueue(label: "engine.docker.daemon")
    private var state: DockerSystemState = .unknown
    private var startTask: Task<Void, Never>?

    /// Cheap, no-state-mutation daemon probe. Same call the lifecycle gate
    /// uses (`SyncDocker.daemonRunning`) so the two views never disagree.
    private let daemonProbe: @Sendable () -> Bool

    /// `open -a Docker` (or a stub in tests).
    private let openDocker: @Sendable () async -> Void

    /// `osascript quit app "Docker"` (or a stub in tests).
    private let quitDocker: @Sendable () async -> Void

    init(
        daemonProbe: @escaping @Sendable () -> Bool = { SyncDocker.daemonRunning(timeout: 2) },
        openDocker: @escaping @Sendable () async -> Void = {
            _ = try? await EngineShell.run(
                executable: "/usr/bin/open",
                arguments: ["-a", "Docker"],
                timeout: 10
            )
        },
        quitDocker: @escaping @Sendable () async -> Void = {
            _ = try? await EngineShell.run(
                executable: "/usr/bin/osascript",
                arguments: ["-e", "quit app \"Docker\""],
                timeout: 10
            )
        }
    ) {
        self.daemonProbe = daemonProbe
        self.openDocker = openDocker
        self.quitDocker = quitDocker
    }

    // MARK: - Status

    /// Snapshot read of the current daemon state. Cheap.
    func status() -> DockerSystemState {
        queue.sync { state }
    }

    // MARK: - Start

    /// Kick off `open -a Docker` then poll for daemon readiness up to 60s.
    /// State transitions `.starting → .running` on success, `.startFailed`
    /// on timeout, `.stopped` on cancellation.
    ///
    /// Returns once the work has been *dispatched* onto an internal Task,
    /// not when the daemon is ready. Clients poll `docker.daemon.status` to
    /// observe the final state — same shape as `services.start`.
    ///
    /// Concurrent calls while already `.starting` are no-ops; the existing
    /// in-flight Task continues.
    func start() async {
        // Transition under the queue and capture whether we need to spin up
        // a Task. If state was already `.starting`, return without doing
        // anything — concurrent caller is folded into the existing task.
        let shouldDispatch: Bool = queue.sync {
            if case .starting = state { return false }
            state = .starting
            return true
        }
        guard shouldDispatch else { return }

        // Spawn the background work. We don't `await task.value` here — the
        // method returns as soon as the open + poll work is scheduled. The
        // dispatch is otherwise prompt (just an enqueue), so semantics match
        // the app's old performDockerStart from the caller's perspective.
        let openDocker = self.openDocker
        let daemonProbe = self.daemonProbe
        let task = Task<Void, Never> { [weak self] in
            await openDocker()
            let ready = await Self.awaitDaemonReady(
                probe: daemonProbe,
                timeout: Self.readyTimeout,
                pollIntervalNS: Self.pollIntervalNS
            )
            // If we were cancelled mid-await, the cancel path has already set
            // `.stopped`; don't stomp on it.
            if Task.isCancelled { return }
            self?.finishStart(ready: ready)
        }
        queue.sync { startTask = task }
    }

    /// Quit Docker Desktop via AppleScript. Cleaner than killing the process
    /// because it lets the VM shut down gracefully. State → `.stopped` on
    /// success. A `stop()` issued while `.starting` is a no-op — clients
    /// should use `cancelStart()` for that case.
    func stop() async {
        let shouldQuit: Bool = queue.sync {
            if case .starting = state { return false }
            return true
        }
        guard shouldQuit else { return }

        await quitDocker()
        queue.sync { state = .stopped }
    }

    /// Cancel any in-flight `.starting` Task. State → `.stopped`. Also fires
    /// a graceful AppleScript quit in a detached task so Docker doesn't keep
    /// booting in the background. Mirrors `ServiceStore.cancelDockerStartInFlight`.
    /// No-op when not currently `.starting`.
    func cancelStart() {
        let task: Task<Void, Never>? = queue.sync {
            guard case .starting = state else { return nil }
            let t = startTask
            startTask = nil
            state = .stopped
            return t
        }
        guard let task else { return }
        task.cancel()
        // Best-effort graceful quit — fire-and-forget. The graceful quit can
        // hang while Docker is still booting; we don't wait for it. Matches
        // the app's pre-2f cancel path which uses `Task.detached`.
        let quitDocker = self.quitDocker
        Task.detached { await quitDocker() }
    }

    /// Acknowledge a `.startFailed` state — clears the indicator so the user
    /// can try again. No-op for any other state. Mirrors
    /// `ServiceStore.clearDockerStartFailure`.
    func clearFailure() {
        queue.sync {
            if case .startFailed = state { state = .stopped }
        }
    }

    // MARK: - Internals

    /// Set the terminal state after `awaitDaemonReady` returns. Run under
    /// the queue so we don't race a concurrent `cancelStart()` between the
    /// two writes. If the start task was cancelled (and therefore detached
    /// from `startTask`), don't overwrite the cancel path's `.stopped`.
    private func finishStart(ready: Bool) {
        queue.sync {
            // If `startTask` was cleared (by cancelStart), the cancel path
            // already set `.stopped`. Don't stomp.
            guard startTask != nil else { return }
            state = ready ? .running : .startFailed("Docker didn't come up in time")
            startTask = nil
        }
    }

    /// Poll the daemon until it answers or `timeout` elapses. Identical
    /// shape to the app's `DockerProbe.awaitDaemonReady` — respects
    /// `Task.isCancelled` between probes.
    private static func awaitDaemonReady(
        probe: @Sendable () -> Bool,
        timeout: TimeInterval,
        pollIntervalNS: UInt64
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Task.isCancelled { return false }
            if probe() { return true }
            if Task.isCancelled { return false }
            try? await Task.sleep(nanoseconds: pollIntervalNS)
        }
        return false
    }
}
