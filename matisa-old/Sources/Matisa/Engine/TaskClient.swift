import Foundation
import MatisaCore

/// Engine dispatchers for `tasks.*` RPCs (start / cancel / clear /
/// close_pane). `tasks.start` and `tasks.cancel` use the four-arm shape so
/// callers can fall back to the local TaskRunner on transport failure;
/// `tasks.clear` and `tasks.close_pane` are pure mirrors of an optimistic
/// local update — they're issued fire-and-forget so a transport failure
/// can't undo what the UI already showed.
struct TaskClient {

    init() {}

    func start(
        serviceID: String,
        name: String,
        command: String,
        cwd: URL,
        extraEnv: [String: String]
    ) async -> EngineDispatchResult {
        let params = TaskStartClientParams(
            id: serviceID,
            name: name,
            command: command,
            cwd: cwd,
            extraEnv: extraEnv
        )
        return await dispatch("tasks.start", params: params)
    }

    func cancel(serviceID: String, name: String) async -> EngineDispatchResult {
        await dispatch(
            "tasks.cancel",
            params: TaskCancelClientParams(id: serviceID, name: name)
        )
    }

    /// Fire-and-forget engine clear. The caller has already done an
    /// optimistic local clear so the UI updated immediately; a transport
    /// failure here is non-actionable.
    func clear(serviceID: String, name: String) async {
        _ = try? await EngineClient.shared.call(
            "tasks.clear",
            params: TaskCancelClientParams(id: serviceID, name: name),
            as: EmptyResponse.self
        )
    }

    /// Fire-and-forget engine close_pane. The caller has already hidden the
    /// pane locally; a transport failure here is non-actionable.
    func closePane(serviceID: String, name: String) async {
        _ = try? await EngineClient.shared.call(
            "tasks.close_pane",
            params: TaskCancelClientParams(id: serviceID, name: name),
            as: EmptyResponse.self
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
