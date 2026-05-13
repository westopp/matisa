import Foundation
import MatisaCore

/// Builds the merged service list on demand. Pulls config from
/// `ConfigService`, discovery results from `DiscoveryService`, and persisted
/// spawns from `PersistedSpawnStore`; pre-computes the I/O bits the merge
/// needs (PID liveness, app-name resolution); then runs `ServiceMerge.merge`.
///
/// Thread-safe via a serial queue. The underlying services (config,
/// discovery) have their own caches, so the only per-call work is the
/// liveness sweep, the lsof-for-cwd app-name lookup, and the merge itself.
final class ServicesService {

    private let configService: ConfigService
    private let discoveryService: DiscoveryService
    private let spawnStore: PersistedSpawnStore
    private let queue = DispatchQueue(label: "engine.services", qos: .userInitiated)

    init(
        configService: ConfigService,
        discoveryService: DiscoveryService,
        spawnStore: PersistedSpawnStore = PersistedSpawnStore()
    ) {
        self.configService = configService
        self.discoveryService = discoveryService
        self.spawnStore = spawnStore
    }

    /// Build one snapshot. Throws if config can't be loaded — the app's
    /// fallback path catches that and rebuilds locally.
    func snapshot() throws -> ServicesSnapshot {
        try queue.sync {
            let config = try loadConfig()
            let discovery = discoveryService.snapshot()
            let spawns = spawnStore.spawns()

            let livePIDs = SyncProcess.livePIDs(of: spawns.map(\.pid))

            // Resolve app names for every dev-y listening pid. The merge
            // applies the same heuristic when filtering, so we resolve a
            // superset (cheap — one lsof call) and the merge picks the
            // entries that actually end up unmanaged.
            var unmanagedCandidates: [Int32] = []
            var seen: Set<Int32> = []
            for lp in discovery.ports
            where UnmanagedHeuristics.looksLikeDevServer(lp) && lp.pid > 1 && seen.insert(lp.pid).inserted {
                unmanagedCandidates.append(lp.pid)
            }
            let appNames = SyncProcessIntrospect.resolveAppNames(for: unmanagedCandidates)

            let merged = ServiceMerge.merge(
                config: config,
                snapshot: discovery,
                spawns: spawns,
                liveSpawnPIDs: livePIDs,
                appNamesByPID: appNames
            )

            // Phase 2c.2: the engine now owns the state file, so this is the
            // authoritative cleanup point for stale spawn records (PIDs that
            // died without going through the lifecycle stop path — power loss,
            // OOM kills, manual `kill -9`, etc.). 2b.2 had the app's local
            // merge doing this; the app keeps it as fallback only.
            for id in merged.deadSpawnIDs {
                spawnStore.remove(serviceID: id)
            }

            return ServicesSnapshot(
                managed: merged.managed,
                unmanaged: merged.unmanaged,
                dockerDaemonRunning: discovery.dockerDaemonRunning,
                takenAt: discovery.takenAt
            )
        }
    }

    /// Look up a single service by id. Builds the same snapshot used by
    /// `services.snapshot` and searches both managed and unmanaged lists.
    /// Used by `LifecycleService` to resolve the action target. Returns nil
    /// for unknown ids; throws when the underlying config load fails.
    func lookup(serviceID: String) throws -> Service? {
        let snap = try snapshot()
        return snap.managed.first(where: { $0.id == serviceID })
            ?? snap.unmanaged.first(where: { $0.id == serviceID })
    }

    /// Exposes the store so LifecycleService can write the same file the
    /// snapshot reads from. (Both go through the same instance — single
    /// queue, no double-write.)
    var spawnStoreRef: PersistedSpawnStore { spawnStore }

    private func loadConfig() throws -> AppConfig {
        let bytes = try configService.get()
        do {
            let raw = try JSONDecoder().decode(RawConfig.self, from: bytes)
            return try AppConfig.from(raw)
        } catch {
            throw RPCError.internalError("config decode failed: \(error)")
        }
    }
}
