import Foundation
import MatisaCore

/// Engine-unreachable bodies for Docker Desktop daemon control. Pre-3 these
/// lived inline on `ServiceStore`; they run when the engine isn't reachable
/// and the app has to drive Docker Desktop directly via the local
/// `DockerProbe.startDockerDesktop` / `stopDockerDesktop` / `awaitDaemonReady`
/// helpers.
///
/// `awaitEngineDockerSettled` stays on the main store — it polls the engine
/// over the wire and only makes sense on the engine path.
@MainActor
extension ServiceStore {

    /// Engine-unreachable path. Same behaviour as the pre-2f implementation:
    /// AppleScript quit, then optimistic mirror update.
    func performDockerStopLocal() async {
        await DockerProbe.stopDockerDesktop()
        dockerSystem = .stopped
        await refresh()
    }

    /// Engine-unreachable path. Identical to the pre-2f implementation —
    /// the local `dockerStartTask` is kept so `cancelDockerStartInFlight`
    /// can cancel a fallback-path start.
    func performDockerStartLocal() async {
        guard !dockerSystem.isStarting else { return }
        dockerSystem = .starting
        let task = Task<Void, Never> { [weak self] in
            await DockerProbe.startDockerDesktop()
            let ready = await DockerProbe.awaitDaemonReady(timeout: 60)
            guard let self else { return }
            guard !Task.isCancelled else { return }
            self.dockerSystem = ready ? .running : .startFailed("Docker didn't come up in time")
        }
        dockerStartTask = task
        await task.value
        dockerStartTask = nil
        await refresh()
    }

    /// Engine-unreachable path. Same body as the pre-2f `confirmDockerStart`.
    func confirmDockerStartLocal(prompt: PendingDockerPrompt) async {
        dockerSystem = .starting
        let task = Task<Void, Never> { [weak self] in
            await DockerProbe.startDockerDesktop()
            let ready = await DockerProbe.awaitDaemonReady(timeout: 60)
            guard let self else { return }
            guard !Task.isCancelled else { return }
            self.dockerSystem = ready ? .running : .startFailed("Docker didn't come up in time")
        }
        dockerStartTask = task
        await task.value
        dockerStartTask = nil
        guard case .running = dockerSystem else { return }
        guard let service = self.service(id: prompt.serviceID) else { return }
        await perform(prompt.action, on: service)
    }
}
