import Foundation
import MatisaCore

/// Refresh-time RPC poller. ServiceStore.refresh() used to inline a wall of
/// sequential `try? await EngineClient.shared.call(...)` blocks — one per
/// engine-owned subsystem (services, launch failures, docker daemon, caddy,
/// public tunnels, same-network, per-pane task lists). `EngineMirror.pull`
/// runs the same calls in the same order and returns an optional-per-field
/// `Snapshot`; the caller applies non-nil fields and falls back to local
/// merge when `services` itself is nil.
///
/// The mirror has no observable state of its own — it's a pure read-side
/// helper. Lives on the main actor so callers don't need to hop actors to
/// invoke it, and so the `paneVisibleTaskServiceIDs` argument can be read
/// directly from `TaskRunner.isPaneVisible`.
@MainActor
final class EngineMirror {

    /// One refresh tick's worth of engine state. Every field is optional —
    /// `nil` means "the engine didn't answer for this slice; leave the
    /// caller's local view untouched". When `services` is nil, the caller
    /// treats the entire refresh as engine-unreachable and runs the local
    /// merge fallback.
    struct Snapshot {
        let services: ServicesSnapshot?
        let launchFailures: [String: LaunchFailure]?
        let engine: EngineStatusInfo?
        let dockerSystem: DockerSystemState?
        let caddy: CaddyServiceInfo?
        let publicTunnels: [String: PublicTunnelStatus]?
        let sameNetwork: [String: SameNetworkStatus]?
        /// Per-service task lists, keyed by service id. Only populated for
        /// services whose build/script pane is currently visible — see
        /// `paneVisibleTaskServiceIDs` on `pull`. Per-service entries are
        /// omitted when the individual `tasks.list` RPC fails.
        let tasksByServiceID: [String: [MatisaCore.TaskKind: MatisaCore.TaskSlot]]
    }

    init() {}

    /// Pull the full engine view in one refresh tick.
    ///
    /// `paneVisibleTaskServiceIDs` is the set of service ids whose
    /// build/script pane is currently visible in the UI — `tasks.list(id)` is
    /// fetched only for those, matching the pre-3 behaviour (the 4s tick
    /// would otherwise issue one RPC per service every refresh).
    ///
    /// If `services.snapshot` fails, returns a snapshot with all fields nil
    /// and `tasksByServiceID` empty — the caller treats that as "engine
    /// unreachable, fall back to local". If `services.snapshot` succeeds but
    /// a subsidiary call fails (e.g. `launch_failures.list`), the
    /// corresponding field is left nil; the caller leaves its local mirror
    /// untouched for that subsystem.
    func pull(paneVisibleTaskServiceIDs: Set<String>) async -> Snapshot {
        // services.snapshot is the gate — when it fails, we treat the whole
        // refresh as engine-unreachable and skip the subsequent calls.
        guard let snap = try? await EngineClient.shared.call(
            "services.snapshot",
            as: ServicesSnapshot.self
        ) else {
            return Snapshot(
                services: nil,
                launchFailures: nil,
                engine: nil,
                dockerSystem: nil,
                caddy: nil,
                publicTunnels: nil,
                sameNetwork: nil,
                tasksByServiceID: [:]
            )
        }

        // Engine status — version, uptime, ok flag. Cheap; pulled every
        // refresh so the System group's Engine row reflects current state.
        let engineStatus = try? await EngineClient.shared.call(
            "engine.status",
            as: EngineStatusInfo.self
        )

        // Engine is the authority on launch failures when reachable —
        // replace the local map wholesale. Best-effort: on transport
        // failure for this call alone, leave the existing map intact
        // (next tick will retry).
        let failures: [String: LaunchFailure]?
        if let list = try? await EngineClient.shared.call(
            "launch_failures.list",
            as: LaunchFailuresList.self
        ) {
            failures = list.failures
        } else {
            failures = nil
        }

        // Engine owns the Docker daemon state machine when reachable.
        let dockerState = try? await EngineClient.shared.call(
            "docker.daemon.status",
            as: DockerSystemState.self
        )

        // Caddy snapshot.
        let caddy = try? await EngineClient.shared.call(
            "caddy.status",
            as: CaddyServiceInfo.self
        )

        // Ad-hoc tasks — only for services with a visible pane. Gating on
        // pane visibility keeps the per-service RPC out of the 4s tick for
        // the common case where no panes are open. Runs before the tunnel /
        // same-network mirrors to preserve the pre-3 call ordering.
        var tasksByID: [String: [MatisaCore.TaskKind: MatisaCore.TaskSlot]] = [:]
        for id in paneVisibleTaskServiceIDs {
            if let list = try? await EngineClient.shared.call(
                "tasks.list",
                params: ServiceIDParams(id: id),
                as: TaskList.self
            ) {
                tasksByID[id] = list.slots
            }
        }

        // Public tunnels — engine view of the per-service tunnel map.
        let tunnels: [String: PublicTunnelStatus]?
        if let list = try? await EngineClient.shared.call(
            "exposure.public_tunnel.list",
            as: PublicTunnelStatusList.self
        ) {
            tunnels = list.statuses
        } else {
            tunnels = nil
        }

        // Same-network (mDNS) — engine view of the per-service map.
        let sameNetwork: [String: SameNetworkStatus]?
        if let list = try? await EngineClient.shared.call(
            "exposure.same_network.list",
            as: SameNetworkStatusList.self
        ) {
            sameNetwork = list.statuses
        } else {
            sameNetwork = nil
        }

        return Snapshot(
            services: snap,
            launchFailures: failures,
            engine: engineStatus,
            dockerSystem: dockerState,
            caddy: caddy,
            publicTunnels: tunnels,
            sameNetwork: sameNetwork,
            tasksByServiceID: tasksByID
        )
    }
}
