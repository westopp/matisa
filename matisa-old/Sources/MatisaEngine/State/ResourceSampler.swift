import Foundation
import Darwin
import MatisaCore

/// Engine-side resource sampler. Given a set of `(serviceID, pid)` pairs,
/// walks each process tree, calls `proc_pid_rusage` on every PID, and returns
/// per-service aggregated CPU% / mem footprint / process count.
///
/// CPU% is a delta-over-wall-clock measurement, so the first sample for a new
/// PID always returns 0% — there's no prior data point to subtract from. The
/// sampler caches `(cumulativeCPUns, sampledAt)` per PID across calls; the
/// next sample produces the real %. With the app's 4s refresh cadence the
/// "first 0%" only shows up immediately after a service starts.
///
/// Lives on a dispatch queue rather than as an actor so the per-PID rusage
/// syscalls don't suspend through the cooperative pool. The queue serializes
/// the cache mutations; concurrent samples for different services would
/// duplicate child-walk work, and the operation is fast enough (~ms per tree)
/// that one-at-a-time is fine.
final class ResourceSampler {

    private struct CacheEntry {
        let cpuNs: UInt64
        let sampledAt: Date
    }

    private let queue = DispatchQueue(label: "engine.resource-sampler")
    private var cache: [pid_t: CacheEntry] = [:]

    init() {}

    /// Sample every service whose `(id, pid)` is supplied. Services with no
    /// PID (stopped, or `.running(pid: 0, ...)` for compose stacks) are
    /// skipped — the engine doesn't have a single PID to root the walk on.
    ///
    /// Returns a map keyed by service id. Entries that fail to sample (process
    /// exited mid-walk, permission denied, etc.) are omitted so the app's
    /// rendering side can fall back to showing nothing rather than zeros.
    func sample(roots: [(serviceID: String, pid: pid_t)]) -> [String: ResourceStats] {
        queue.sync {
            let now = Date()
            var out: [String: ResourceStats] = [:]
            var seenPIDs: Set<pid_t> = []

            for (serviceID, rootPID) in roots {
                guard rootPID > 1 else { continue }
                guard let stats = sampleTreeLocked(rootPID: rootPID, now: now, seenPIDs: &seenPIDs) else {
                    continue
                }
                out[serviceID] = stats
            }

            // Drop cache entries for PIDs we didn't see — keeps the cache
            // bounded and avoids stale `cpuNs` confusing a recycled PID.
            // Bounded by the live process count, but cheap to prune.
            cache = cache.filter { seenPIDs.contains($0.key) }

            return out
        }
    }

    // MARK: - Locked helpers

    private func sampleTreeLocked(rootPID: pid_t, now: Date, seenPIDs: inout Set<pid_t>) -> ResourceStats? {
        let pids = walkTree(rootPID: rootPID)
        guard !pids.isEmpty else { return nil }

        var totalCPUPercent: Double = 0
        var totalMem: UInt64 = 0
        var counted = 0

        for pid in pids {
            seenPIDs.insert(pid)
            guard let info = rusage(pid: pid) else { continue }
            counted += 1
            totalMem &+= info.ri_phys_footprint

            let cpuNs = info.ri_user_time &+ info.ri_system_time
            if let prev = cache[pid] {
                let deltaCPU = cpuNs &- prev.cpuNs
                let deltaWall = now.timeIntervalSince(prev.sampledAt)
                if deltaWall > 0 {
                    // ns / s × 100 = %. 1e9 ns per CPU-second of work.
                    let pct = (Double(deltaCPU) / 1_000_000_000.0) / deltaWall * 100.0
                    if pct.isFinite, pct >= 0 {
                        totalCPUPercent += pct
                    }
                }
            }
            cache[pid] = CacheEntry(cpuNs: cpuNs, sampledAt: now)
        }

        guard counted > 0 else { return nil }
        return ResourceStats(
            cpuPercent: totalCPUPercent,
            memBytes: totalMem,
            processCount: counted
        )
    }

    /// BFS from `rootPID`, including the root. Children come from
    /// `proc_listpids(PROC_PPID_ONLY, parent, ...)`. Self-loops or cycles
    /// can't happen via that API, but we still guard with a visited-set so a
    /// kernel-side surprise doesn't loop forever.
    private func walkTree(rootPID: pid_t) -> [pid_t] {
        var visited: Set<pid_t> = [rootPID]
        var order: [pid_t] = [rootPID]
        var frontier: [pid_t] = [rootPID]

        while let parent = frontier.popLast() {
            for child in directChildren(of: parent) where !visited.contains(child) {
                visited.insert(child)
                order.append(child)
                frontier.append(child)
            }
        }
        return order
    }

    /// Direct children of `ppid` via `proc_listpids(PROC_PPID_ONLY, ppid, ...)`.
    /// Returns an empty array on any error (no children, permission denied,
    /// API absent on this kernel).
    private func directChildren(of ppid: pid_t) -> [pid_t] {
        // First call with NULL/0 to learn the required buffer size. The kernel
        // returns the byte size; we round up to one extra slot in case the
        // process forks between the size query and the data fetch.
        let needed = proc_listpids(UInt32(PROC_PPID_ONLY), UInt32(ppid), nil, 0)
        guard needed > 0 else { return [] }

        let count = Int(needed) / MemoryLayout<pid_t>.size + 8
        var buffer = [pid_t](repeating: 0, count: count)
        let got = buffer.withUnsafeMutableBufferPointer { bp -> Int32 in
            proc_listpids(
                UInt32(PROC_PPID_ONLY),
                UInt32(ppid),
                bp.baseAddress,
                Int32(bp.count * MemoryLayout<pid_t>.size)
            )
        }
        guard got > 0 else { return [] }
        let used = Int(got) / MemoryLayout<pid_t>.size
        return Array(buffer.prefix(used)).filter { $0 > 1 }
    }

    /// Fetch `rusage_info_v4` for `pid`. Returns nil if the process has gone
    /// away mid-walk (ESRCH) or if the syscall isn't permitted.
    private func rusage(pid: pid_t) -> rusage_info_v4? {
        var info = rusage_info_v4()
        let rc = withUnsafeMutablePointer(to: &info) { ptr -> Int32 in
            ptr.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { reb in
                proc_pid_rusage(pid, RUSAGE_INFO_V4, reb)
            }
        }
        guard rc == 0 else { return nil }
        return info
    }
}
