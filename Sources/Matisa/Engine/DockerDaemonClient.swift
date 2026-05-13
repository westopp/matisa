import Foundation
import MatisaCore

/// Engine dispatchers for `docker.daemon.*` RPCs. The docker.daemon RPCs
/// can't themselves return -32001 (they're how the daemon is brought up),
/// so the dispatch shape is rpcError | engineUnreachable | ok — no
/// dockerDaemonRequired arm.
///
/// `start`, `stop` and `status` return typed payloads; `cancelStart` and
/// `clearFailure` are fire-and-forget on the app side.
struct DockerDaemonClient {

    init() {}

    func start() async -> EngineDispatchResult {
        await dispatch("docker.daemon.start")
    }

    func stop() async -> EngineDispatchResult {
        await dispatch("docker.daemon.stop")
    }

    func cancelStart() async -> EngineDispatchResult {
        await dispatch("docker.daemon.cancel_start")
    }

    func clearFailure() async -> EngineDispatchResult {
        await dispatch("docker.daemon.clear_failure")
    }

    /// One-shot `docker.daemon.status` poll. Used by the start-settled wait
    /// loop. Returns `nil` on any transport / decode / rpc failure so the
    /// caller can decide whether to keep polling or bail.
    func status() async -> DockerSystemState? {
        try? await EngineClient.shared.call(
            "docker.daemon.status",
            as: DockerSystemState.self
        )
    }

    private func dispatch(_ method: String) async -> EngineDispatchResult {
        do {
            _ = try await EngineClient.shared.call(
                method,
                as: EmptyResponse.self
            )
            return .ok
        } catch EngineClient.ClientError.rpcError(_, let msg) {
            return .rpcError(message: msg)
        } catch {
            return .engineUnreachable
        }
    }
}
