import Foundation

/// Per-service resource utilisation, aggregated across the full process tree
/// rooted at the service's PID. Sampled engine-side via `proc_pid_rusage`
/// (CPU+mem) plus `proc_listpids(PROC_PPID_ONLY, ...)` to discover children.
///
/// `cpuPercent` is the sum across the tree, so values can exceed 100 on
/// multi-core processes (e.g. a `node` worker using 2 cores reports `~200`).
/// Matches Activity Monitor / `top -c`'s conventions so the numbers line up
/// when a user cross-checks.
///
/// `memBytes` is the sum of `ri_phys_footprint` across the tree — the same
/// "Memory" column Activity Monitor shows. We don't deduplicate shared pages
/// across children; for the dev-tool surface that's good enough and matches
/// what Activity Monitor reports.
///
/// `processCount` is informational — surfaces "1 proc" vs "12 procs" in the
/// detail-view tooltip so the user can spot runaway child fanout.
public struct ResourceStats: Codable, Hashable, Sendable {
    public let cpuPercent: Double
    public let memBytes: UInt64
    public let processCount: Int

    public init(cpuPercent: Double, memBytes: UInt64, processCount: Int) {
        self.cpuPercent = cpuPercent
        self.memBytes = memBytes
        self.processCount = processCount
    }

    /// "12%" / "234%". Integer-rounded; sub-1% rounds to "0%" rather than
    /// "<1%" since we sample on a coarse 4s tick — fractional precision is
    /// noise at that cadence.
    public var cpuLabel: String {
        "\(Int(cpuPercent.rounded()))%"
    }

    /// "45 MB" / "1.2 GB". Two-digit precision above 1 GB; integer below.
    /// Uses 1024-scaled units to match Activity Monitor.
    public var memLabel: String {
        let kb = Double(memBytes) / 1024.0
        let mb = kb / 1024.0
        let gb = mb / 1024.0
        if gb >= 1.0 {
            return String(format: "%.1f GB", gb)
        }
        if mb >= 1.0 {
            return "\(Int(mb.rounded())) MB"
        }
        if kb >= 1.0 {
            return "\(Int(kb.rounded())) KB"
        }
        return "\(memBytes) B"
    }
}

/// Wire shape for the `resources.snapshot` RPC. Keyed by service id so the
/// app can apply the map directly to `ServiceStore.resourceStats` without
/// per-row reconciliation.
public struct ResourcesSnapshot: Codable, Hashable, Sendable {
    public let stats: [String: ResourceStats]
    public let takenAt: Date

    public init(stats: [String: ResourceStats], takenAt: Date) {
        self.stats = stats
        self.takenAt = takenAt
    }
}
