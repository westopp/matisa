import Foundation
import MatisaCore

/// Engine dispatchers for the `services.*` lifecycle RPCs plus
/// `launch_failures.clear`. Pure dispatch — classifies the call outcome into
/// an `EngineDispatchResult` and returns; doesn't decide what to do with
/// `.engineUnreachable` (the caller falls back to its `*Local` body) and
/// doesn't write any UI state.
///
/// Pre-3, `ServiceStore.start/stop/kill/restart/takeOver/pull` each inlined
/// the same four-arm try/catch over `EngineClient.shared.call`. This client
/// collapses all six into one mechanical dispatch shape.
struct LifecycleClient {

    init() {}

    func start(serviceID: String, activeEnvContext: String?) async -> EngineDispatchResult {
        await dispatch(
            "services.start",
            params: ServiceLifecycleClientParams(id: serviceID, activeEnvContext: activeEnvContext)
        )
    }

    func stop(serviceID: String) async -> EngineDispatchResult {
        await dispatch("services.stop", params: ServiceIDParams(id: serviceID))
    }

    func kill(serviceID: String) async -> EngineDispatchResult {
        await dispatch("services.kill", params: ServiceIDParams(id: serviceID))
    }

    func restart(serviceID: String, activeEnvContext: String?) async -> EngineDispatchResult {
        await dispatch(
            "services.restart",
            params: ServiceLifecycleClientParams(id: serviceID, activeEnvContext: activeEnvContext)
        )
    }

    func takeOver(serviceID: String, activeEnvContext: String?) async -> EngineDispatchResult {
        await dispatch(
            "services.take_over",
            params: ServiceLifecycleClientParams(id: serviceID, activeEnvContext: activeEnvContext)
        )
    }

    func pull(serviceID: String) async -> EngineDispatchResult {
        await dispatch("services.pull", params: ServiceIDParams(id: serviceID))
    }

    /// Best-effort clear of an engine-side launch-failure entry. Used when
    /// the user dismisses the detail-view banner — the local entry is
    /// dropped regardless, so the engine clear is fire-and-forget.
    func clearLaunchFailure(serviceID: String) async -> EngineDispatchResult {
        await dispatch(
            "launch_failures.clear",
            params: ServiceIDParams(id: serviceID)
        )
    }

    private func dispatch(_ method: String, params: Encodable) async -> EngineDispatchResult {
        do {
            _ = try await EngineClient.shared.call(
                method,
                params: params,
                as: EmptyResponse.self
            )
            return .ok
        } catch EngineClient.ClientError.rpcError(let code, _) where code == -32001 {
            return .dockerDaemonRequired
        } catch EngineClient.ClientError.rpcError(_, let msg) {
            return .rpcError(message: msg)
        } catch {
            return .engineUnreachable
        }
    }
}
