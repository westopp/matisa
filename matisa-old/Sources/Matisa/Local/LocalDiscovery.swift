import Foundation
import MatisaCore

/// Engine-unreachable bodies for the refresh-time inputs (`gatherDiscovery`
/// and `localMerge`). Pre-3 these lived inline on `ServiceStore`. They run
/// every refresh tick — the discovery snapshot tries the engine's cached
/// copy first and falls back to the local probes; the local merge is the
/// pre-2b.2 `ServiceMerge.merge` shape, run against locally-gathered inputs
/// when `services.snapshot` is unavailable.
@MainActor
extension ServiceStore {

    /// Local-fallback merge. Runs the same `ServiceMerge.merge` the engine
    /// uses, against locally-gathered inputs. Also cleans up dead persisted
    /// spawns the merge identifies — the engine ignores `deadSpawnIDs` in
    /// Phase 2b.2 since the file is app-owned.
    func localMerge(
        config: AppConfig,
        snapshot: DiscoverySnapshot
    ) async -> ServiceMerge.Result {
        let spawns = StatePersistence.load().spawns
        let liveSpawnPIDs = Set(
            spawns.filter { ProcessSupervisor.isAlive(pid: $0.pid) }.map(\.pid)
        )

        var candidates: [Int32] = []
        var seenPIDs: Set<Int32> = []
        for lp in snapshot.ports
        where UnmanagedHeuristics.looksLikeDevServer(lp)
            && lp.pid > 1
            && seenPIDs.insert(lp.pid).inserted {
            candidates.append(lp.pid)
        }
        let appNames = await ProcessIntrospect.resolveAppNames(for: candidates)

        let result = ServiceMerge.merge(
            config: config,
            snapshot: snapshot,
            spawns: spawns,
            liveSpawnPIDs: liveSpawnPIDs,
            appNamesByPID: appNames
        )

        for id in result.deadSpawnIDs {
            StatePersistence.remove(serviceID: id)
        }
        return result
    }

    /// Phase 2b.1: gather all discovery probe results in one call. Tries the
    /// engine first; on any transport failure (engine not running, decode
    /// error, etc.) falls back to running the probes locally — the same
    /// async path the app used pre-2b.
    func gatherDiscovery() async -> DiscoverySnapshot {
        if let snap = try? await EngineClient.shared.call(
            "discovery.snapshot",
            as: DiscoverySnapshot.self
        ) {
            return snap
        }
        // Local fallback. Same sequence as the original refresh() body —
        // the daemon probe gates docker/compose to skip a docker-ps that
        // would just time out when Docker is down.
        let dockerUp = await DockerProbe.daemonRunning()
        let ports = (try? await Lsof.listening()) ?? []
        let containers = dockerUp ? await DockerProbe.listContainers() : []
        let composeStacks = dockerUp ? await DockerProbe.listComposeStacks() : []
        let brew = await BrewServices.list()
        return DiscoverySnapshot(
            ports: ports,
            containers: containers,
            composeStacks: composeStacks,
            brewServices: brew,
            dockerDaemonRunning: dockerUp,
            takenAt: Date()
        )
    }
}
