import Foundation
import MatisaCore

/// Engine dispatchers for `caddy.*` RPCs. Caddy actions don't return -32001;
/// they're brew-service control plus Caddyfile rendering. Dispatch shape is
/// rpcError | engineUnreachable | ok.
///
/// `validate` returns a typed `CaddyValidationResult` rather than
/// `EmptyResponse` — the engine's validate handler emits the validation
/// outcome; the app doesn't currently render it, but the call shape stays
/// the same so future use is a field-read rather than a wire change.
struct CaddyClient {

    init() {}

    func start() async -> EngineDispatchResult {
        await dispatch("caddy.start")
    }

    func stop() async -> EngineDispatchResult {
        await dispatch("caddy.stop")
    }

    func restart() async -> EngineDispatchResult {
        await dispatch("caddy.restart")
    }

    func reload() async -> EngineDispatchResult {
        await dispatch("caddy.reload")
    }

    func regenerate() async -> EngineDispatchResult {
        await dispatch("caddy.regenerate")
    }

    /// Validate the engine-rendered Caddyfile. Same dispatch shape as the
    /// other actions; the validation result itself is discarded today —
    /// the UI surface for it lives in a future task.
    func validate() async -> EngineDispatchResult {
        do {
            _ = try await EngineClient.shared.call(
                "caddy.validate",
                as: CaddyValidationResult.self
            )
            return .ok
        } catch EngineClient.ClientError.rpcError(_, let msg) {
            return .rpcError(message: msg)
        } catch {
            return .engineUnreachable
        }
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
