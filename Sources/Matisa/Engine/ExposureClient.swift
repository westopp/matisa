import Foundation
import MatisaCore

/// Engine dispatchers for `exposure.public_tunnel.toggle` and
/// `exposure.same_network.toggle`. The engine handles all the gating
/// (service running, ssh key present, port available, LAN interface
/// available) so the app side doesn't preflight on the engine path.
/// Dispatch shape is rpcError | engineUnreachable | ok — these RPCs don't
/// return -32001.
struct ExposureClient {

    init() {}

    func togglePublicTunnel(serviceID: String) async -> EngineDispatchResult {
        await dispatch(
            "exposure.public_tunnel.toggle",
            params: ServiceIDParams(id: serviceID)
        )
    }

    func toggleSameNetwork(serviceID: String) async -> EngineDispatchResult {
        await dispatch(
            "exposure.same_network.toggle",
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
        } catch EngineClient.ClientError.rpcError(_, let msg) {
            return .rpcError(message: msg)
        } catch {
            return .engineUnreachable
        }
    }
}
