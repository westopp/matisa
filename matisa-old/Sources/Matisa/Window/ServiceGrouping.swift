import Foundation
import MatisaCore

/// A bucket of services that share the same group name (after
/// trim+lowercase comparison). `displayName` is the first-seen casing.
struct ServiceGroup: Hashable {
    let key: String          // normalised: trimmed + lowercased
    let displayName: String  // trimmed; first-seen casing
    let services: [Service]
}

enum ServiceGrouping {
    /// Splits services into ungrouped (no `group` declared) and grouped
    /// buckets, preserving the original ordering both within and across
    /// groups. Comparison is case-insensitive and whitespace-trimmed; the
    /// first-seen casing wins for display.
    static func partition(_ services: [Service]) -> (ungrouped: [Service], groups: [ServiceGroup]) {
        var ungrouped: [Service] = []
        var order: [String] = []
        var buckets: [String: (display: String, services: [Service])] = [:]

        for svc in services {
            guard let raw = svc.spec.group else {
                ungrouped.append(svc)
                continue
            }
            let display = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !display.isEmpty else {
                ungrouped.append(svc)
                continue
            }
            let key = display.lowercased()
            if buckets[key] == nil {
                buckets[key] = (display, [svc])
                order.append(key)
            } else {
                buckets[key]?.services.append(svc)
            }
        }

        let groups = order.map { key in
            let entry = buckets[key]!
            return ServiceGroup(key: key, displayName: entry.display, services: entry.services)
        }
        return (ungrouped, groups)
    }
}
