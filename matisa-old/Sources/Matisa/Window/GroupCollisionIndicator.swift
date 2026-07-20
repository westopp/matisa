import SwiftUI
import MatisaCore

/// Small amber ⚠ shown next to a collapsed group's title when any member
/// of the group has a port collision against another configured service.
/// Mirror of the row-level badge so a clash is still visible when the
/// group is closed. Tooltip lists each offending port + the other service
/// name; the action sits in the detail view (see ServiceDetailView's
/// `collisionBanner`), not in this hover-only surface.
struct GroupCollisionIndicator: View {
    let services: [Service]

    @Environment(ServiceStore.self) private var store

    var body: some View {
        let entries = collisions
        if !entries.isEmpty {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10))
                .foregroundStyle(.orange)
                .help(tooltip(entries))
        }
    }

    /// Unique (port, ownService, otherService) triples for this group.
    /// Deduplicated on port + the pair-of-names so a single 3-way clash
    /// shows as N-choose-2 lines, not N×(N-1) repeats.
    private var collisions: [Entry] {
        let map = store.portCollisionsByServiceID
        var seen: Set<String> = []
        var out: [Entry] = []
        for svc in services {
            for c in (map[svc.id] ?? []) {
                let pair = [svc.name, c.otherServiceName].sorted()
                let key = "\(c.port)|\(pair[0])|\(pair[1])"
                if seen.insert(key).inserted {
                    out.append(Entry(port: c.port, names: pair))
                }
            }
        }
        return out.sorted { ($0.port, $0.names[0]) < ($1.port, $1.names[0]) }
    }

    private func tooltip(_ entries: [Entry]) -> String {
        let header = entries.count == 1
            ? "Port collision"
            : "Port collisions (\(entries.count))"
        let lines = entries.map { ":\($0.port) — \($0.names[0]) ↔ \($0.names[1])" }
        return ([header] + lines).joined(separator: "\n")
    }

    private struct Entry: Hashable {
        let port: Int
        let names: [String]
    }
}
