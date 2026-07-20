import Foundation
import MatisaCore

/// One configured service overlaps with another on the same host port.
/// Used by the row-level badge to surface the clash. The TS-side
/// `validatePortsRegistry()` catches typo-level duplicates in the central
/// registry; this is the runtime check across actual `Service[]`
/// definitions (and the engine's discovered listeners), so it also covers
/// services that haven't yet been migrated to the registry.
public struct PortCollision: Hashable, Sendable {
    public let port: Int
    public let otherServiceName: String
}

@MainActor
extension ServiceStore {
    /// Per-service-id list of port collisions against every other configured
    /// service. Each entry names the offending port and the other service
    /// sharing it. Empty array (or absent key) = no clash.
    ///
    /// Computed from `services` (the managed list) only — unmanaged
    /// listeners would otherwise generate noise on every project that
    /// happens to be running, since the engine reports the project itself
    /// as both `managed` (configured) and incidentally visible to lsof.
    var portCollisionsByServiceID: [String: [PortCollision]] {
        var byPort: [Int: [(id: String, name: String)]] = [:]
        for svc in services {
            for (port, _) in svc.spec.exposedPorts {
                byPort[port, default: []].append((svc.id, svc.name))
            }
        }
        var out: [String: [PortCollision]] = [:]
        for (port, entries) in byPort where entries.count > 1 {
            for entry in entries {
                for other in entries where other.id != entry.id {
                    out[entry.id, default: []].append(
                        PortCollision(port: port, otherServiceName: other.name)
                    )
                }
            }
        }
        return out
    }
}
