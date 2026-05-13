import Foundation
import MatisaCore

/// Engine-side port of the **action** methods on the app's `DockerProbe`.
/// Inline (single-container), compose-stack, and unmanaged (user-owned)
/// container operations. Discovery (`docker ps`, `compose ls`, `docker info`)
/// still lives in `SyncDocker` for the snapshot path — this is a parallel
/// async-shell enum used only by the lifecycle layer.
///
/// Docker Desktop start/stop/await is intentionally NOT here — that's Phase
/// 2f and stays in the app for now.
///
/// MARK: - Not tested directly
/// Every method shells out to the `docker` CLI. We don't want to require a
/// running Docker daemon in CI, so these are exercised via the higher-level
/// services.* RPC tests (added in 2c.2) which mock the action surface, plus
/// manual smoke tests.
enum DockerActions {
    static var dockerPath: String {
        SyncShell.which("docker") ?? "/usr/local/bin/docker"
    }

    // MARK: - Compose actions (whole-stack only)

    static func composeUp(file: URL) async throws {
        try await EngineShell.runCapturingStderrTail(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "up", "-d"],
            currentDirectoryURL: file.deletingLastPathComponent(),
            timeout: 300
        )
    }

    static func composeDown(file: URL) async throws {
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "down"],
            currentDirectoryURL: file.deletingLastPathComponent(),
            timeout: 60
        )
    }

    static func composeRestart(file: URL) async throws {
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "restart"],
            currentDirectoryURL: file.deletingLastPathComponent(),
            timeout: 120
        )
    }

    static func composePull(file: URL) async throws {
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "pull"],
            currentDirectoryURL: file.deletingLastPathComponent(),
            timeout: 300
        )
    }

    // MARK: - Inline (docker run) actions

    /// Container name we use for an inline docker service. Prefixed so we can
    /// recognise our own and avoid collisions with the user's manual containers.
    /// Naming convention lives in `MatisaCore.MatisaContainer` so engine and
    /// app see the same prefix.
    private static func inlineContainerName(_ name: String) -> String {
        MatisaContainer.name(for: name)
    }

    /// Start an inline container. If a container with the same managed name
    /// exists (stopped), reuse it via `start`; otherwise `run -d`. Uses the
    /// sync discovery probe to check for an existing container — fast and
    /// avoids a second async hop.
    static func inlineRun(image: String, name: String, port: Int) async throws {
        let cname = inlineContainerName(name)
        if let existing = SyncDocker.listContainers().first(where: { $0.name == cname }) {
            if existing.isRunning { return }
            try await EngineShell.runCapturingStderrTail(
                executable: dockerPath,
                arguments: ["start", cname],
                timeout: 60
            )
            return
        }
        try await EngineShell.runCapturingStderrTail(
            executable: dockerPath,
            arguments: [
                "run", "-d",
                "--name", cname,
                "--restart", "unless-stopped",
                "-p", "\(port):\(port)",
                image
            ],
            timeout: 300
        )
    }

    static func inlineStop(name: String) async throws {
        let cname = inlineContainerName(name)
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["stop", cname],
            timeout: 60
        )
    }

    static func inlineKill(name: String) async throws {
        let cname = inlineContainerName(name)
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["kill", cname],
            timeout: 30
        )
    }

    static func inlineRestart(name: String) async throws {
        let cname = inlineContainerName(name)
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["restart", cname],
            timeout: 120
        )
    }

    static func inlineRemove(name: String) async throws {
        let cname = inlineContainerName(name)
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["rm", "-f", cname],
            timeout: 60
        )
    }

    static func inlinePull(image: String) async throws {
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["pull", image],
            timeout: 300
        )
    }

    /// Returns true if our managed inline container for `name` is running.
    static func inlineIsRunning(name: String) async -> Bool {
        let cname = inlineContainerName(name)
        return SyncDocker.listContainers().contains(where: { $0.name == cname && $0.isRunning })
    }

    // MARK: - Unmanaged container actions

    /// Start an unmanaged (user-owned) container by raw container name. Unlike
    /// `inline*`, no `matisa.` prefix — the user owns the naming.
    static func unmanagedStart(name: String) async throws {
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["start", name],
            timeout: 60
        )
    }

    static func unmanagedStop(name: String) async throws {
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["stop", name],
            timeout: 60
        )
    }

    static func unmanagedKill(name: String) async throws {
        try await EngineShell.run(
            executable: dockerPath,
            arguments: ["kill", name],
            timeout: 30
        )
    }
}
