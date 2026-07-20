import Foundation

/// Outcome of an engine-first action dispatch. Returned by the per-subsystem
/// clients (LifecycleClient, DockerDaemonClient, CaddyClient, ExposureClient,
/// TaskClient) so the caller in `ServiceStore` can decide how to react —
/// surface the docker prompt, log, fall back to local, etc.
///
/// Pre-3 the same four-arm try/catch was inlined into every action method
/// (12+ copies); this enum centralises the classification so the wrappers
/// become a small switch.
enum EngineDispatchResult {
    /// Engine accepted the action.
    case ok
    /// Engine returned -32001 (dockerDaemonRequired). Callers typically
    /// flip `dockerSystem` to `.stopped` and queue a `PendingDockerPrompt`.
    case dockerDaemonRequired
    /// Engine returned any other JSON-RPC error code (deliberate refusal —
    /// service not found, internal failure, etc.). The associated `message`
    /// is the engine's `error.message` string; callers typically log to
    /// stderr and return without falling back.
    case rpcError(message: String)
    /// Transport / decode failure — the engine isn't usable. Callers fall
    /// back to the local-fallback path.
    case engineUnreachable
}
