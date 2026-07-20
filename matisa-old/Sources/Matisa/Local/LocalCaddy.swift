import Foundation
import MatisaCore

/// Engine-unreachable bodies for the Caddy-side actions (validate, reload,
/// regenerate). Pre-3 these lived inline on `ServiceStore`; they run when
/// the engine isn't reachable and the app has to drive `caddy validate` /
/// `brew services restart` / `CaddyfileGenerator.write` directly.
///
/// The Caddy lifecycle actions (`caddy.start/stop/restart`) don't need a
/// local body of their own — the engine-first wrapper just calls
/// `BrewServices.start/stop/restart` on the engine-unreachable arm.
@MainActor
extension ServiceStore {

    func validateCaddyLocal() async {
        guard let path = caddyService.configFile else { return }
        guard let caddyBin = Shell.which("caddy") else { return }
        _ = try? await Shell.run(
            executable: caddyBin,
            arguments: ["validate", "--config", path.path, "--adapter", "caddyfile"]
        )
    }

    func reloadCaddyLocal() async {
        try? await BrewServices.restart("caddy")
    }

    func regenerateCaddyfileLocal() async {
        guard let config = configLoader.lastConfig else { return }
        _ = try? CaddyfileGenerator.write(
            config,
            services: services,
            exposures: activeExposuresByServiceID
        )
    }

    /// Local-fallback Caddy regen+reload debounce. The user toggling both
    /// exposure modes for one service should still result in one regen and
    /// one reload, not two. The engine handles its own debounce
    /// internally (CaddyService.scheduleRegenAndReload, 150ms) — this
    /// path only runs when the engine is unreachable and the local
    /// MDNSPublisher / TunnelManager toggled state app-side.
    func scheduleCaddyRegenLocal() {
        caddyReloadTask?.cancel()
        caddyReloadTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            await self?.regenerateCaddyfileLocal()
            await self?.reloadCaddyLocal()
        }
    }
}
