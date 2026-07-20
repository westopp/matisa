import Foundation
import MatisaCore

/// Builds `DiscoverySnapshot` on demand. Caches the result for `ttl`
/// seconds so concurrent callers (multiple clients during a refresh tick)
/// share a single round of underlying shell-outs.
///
/// Thread-safe via a serial queue. The actual probes can take 100-500ms
/// total; while one is in flight other connections that ask for a snapshot
/// block on the queue and then read the freshly-cached result.
final class DiscoveryService {

    private let queue = DispatchQueue(label: "engine.discovery", qos: .userInitiated)
    private var cached: DiscoverySnapshot?
    private let ttl: TimeInterval

    init(ttl: TimeInterval = 1.0) {
        self.ttl = ttl
    }

    /// Returns a snapshot, hitting the cache when fresh.
    func snapshot() -> DiscoverySnapshot {
        queue.sync {
            if let c = cached, Date().timeIntervalSince(c.takenAt) < ttl {
                return c
            }
            let snap = takeSnapshot()
            cached = snap
            return snap
        }
    }

    /// Force a fresh snapshot, bypassing the TTL cache. Used by callers that
    /// just performed a state-changing action and want to see the result
    /// reflected immediately.
    func refresh() -> DiscoverySnapshot {
        queue.sync {
            let snap = takeSnapshot()
            cached = snap
            return snap
        }
    }

    private func takeSnapshot() -> DiscoverySnapshot {
        // Daemon probe first — avoids spending time on docker ps when the
        // daemon is down (the call would just time out).
        let dockerUp = SyncDocker.daemonRunning()
        return DiscoverySnapshot(
            ports: SyncLsof.listening(),
            containers: dockerUp ? SyncDocker.listContainers() : [],
            composeStacks: dockerUp ? SyncDocker.listComposeStacks() : [],
            brewServices: SyncBrew.list(),
            dockerDaemonRunning: dockerUp,
            takenAt: Date()
        )
    }
}
