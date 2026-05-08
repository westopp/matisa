import Foundation

/// Lifecycle state of the Docker daemon (Docker Desktop or any compatible
/// provider). The store probes during refresh and during action gating.
enum DockerSystemState: Hashable, Sendable {
    case unknown                  // No probe yet (initial app state)
    case running                  // Daemon answers `docker info`
    case stopped                  // Daemon not reachable
    case starting                 // We invoked `open -a Docker`, polling
    case startFailed(String)      // Polling timed out

    var isRunning: Bool { if case .running = self { return true }; return false }
    var isStarting: Bool { if case .starting = self { return true }; return false }
    var isStartFailed: Bool { if case .startFailed = self { return true }; return false }
}

/// Captures the action a user tried to take when the daemon was found to be
/// down. Used by the alert flow to retry the original action once Docker is
/// up. Identifiable so SwiftUI's `.alert(item:)` can present it.
struct PendingDockerPrompt: Hashable, Identifiable {
    let id: UUID
    let serviceID: String
    let serviceName: String
    let action: ServiceAction

    init(serviceID: String, serviceName: String, action: ServiceAction) {
        self.id = UUID()
        self.serviceID = serviceID
        self.serviceName = serviceName
        self.action = action
    }
}
