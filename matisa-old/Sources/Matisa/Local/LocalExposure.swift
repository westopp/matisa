import Foundation
import MatisaCore

/// Engine-unreachable bodies for the per-service exposure toggles. Pre-3
/// these lived inline on `ServiceStore`; on engine-unreachable we drive the
/// app-side `TunnelManager` / `MDNSPublisher` directly and schedule a local
/// Caddyfile regen+reload through `scheduleCaddyRegenLocal`.
@MainActor
extension ServiceStore {

    func togglePublicTunnelLocal(_ service: Service) {
        let status = tunnels.status(for: service.id)
        if status.isActive {
            tunnels.stop(serviceID: service.id)
            return
        }
        guard service.state.isRunning else { return }
        guard TunnelManager.sshKeyExists(tunnelConfig) else {
            // The Share menu disables this case, but guard anyway.
            return
        }
        guard let port = service.spec.exposedPorts.first?.port else { return }
        tunnels.start(
            serviceID: service.id,
            serviceName: service.name,
            port: port,
            hostHeader: service.spec.primaryURL,
            tunnel: tunnelConfig
        )
    }

    func toggleSameNetworkLocal(_ service: Service) {
        let status = mdns.status(for: service.id)
        if status.isActive {
            mdns.unpublish(serviceID: service.id)
        } else {
            guard mdns.hasLANInterface else { return }
            mdns.advertise(
                serviceID: service.id,
                serviceName: service.name,
                domain: localNetworkConfig.domain
            )
        }
        scheduleCaddyRegenLocal()
    }
}
