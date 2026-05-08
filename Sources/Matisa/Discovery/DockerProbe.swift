import Foundation

struct DockerContainer: Hashable, Sendable {
    let id: String
    let name: String
    let image: String
    let state: String
    let status: String
    let ports: String

    var isRunning: Bool { state == "running" }
}

struct DockerComposeStack: Hashable, Sendable {
    let name: String
    let status: String
    let configFiles: String
}

enum DockerProbe {
    static var dockerPath: String {
        Shell.which("docker") ?? "/usr/local/bin/docker"
    }

    // MARK: - Daemon

    /// Cheap probe: `docker info -f '{{.ServerVersion}}'` returns 0 only when
    /// the daemon is reachable. A short timeout prevents the probe itself from
    /// hanging if the daemon socket exists but nobody's listening.
    static func daemonRunning(timeout: TimeInterval = 3) async -> Bool {
        do {
            let code = try await Shell.run(
                executable: dockerPath,
                arguments: ["info", "-f", "{{.ServerVersion}}"],
                timeout: timeout
            )
            return code == 0
        } catch {
            return false
        }
    }

    /// Launch Docker Desktop. The call returns as soon as `open` hands off to
    /// LaunchServices — the VM/daemon take several seconds more to come up,
    /// so callers should follow this with `awaitDaemonReady`.
    static func startDockerDesktop() async {
        _ = try? await Shell.run(
            executable: "/usr/bin/open",
            arguments: ["-a", "Docker"]
        )
    }

    /// Quit Docker Desktop via AppleScript. Cleaner than killing the process
    /// because it lets the VM shut down gracefully.
    static func stopDockerDesktop() async {
        _ = try? await Shell.run(
            executable: "/usr/bin/osascript",
            arguments: ["-e", "quit app \"Docker\""]
        )
    }

    /// Poll the daemon until it answers or `timeout` elapses. Returns true if
    /// it came up, false on timeout or task cancellation.
    static func awaitDaemonReady(timeout: TimeInterval = 30) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Task.isCancelled { return false }
            if await daemonRunning(timeout: 2) { return true }
            if Task.isCancelled { return false }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        return false
    }

    // MARK: - Discovery

    static func listContainers() async -> [DockerContainer] {
        guard let output = try? await Shell.runCapturing(
            executable: dockerPath,
            arguments: ["ps", "-a", "--format", "{{json .}}"]
        ) else { return [] }
        return parseContainers(output)
    }

    static func listComposeStacks() async -> [DockerComposeStack] {
        guard let output = try? await Shell.runCapturing(
            executable: dockerPath,
            arguments: ["compose", "ls", "--all", "--format", "json"]
        ) else { return [] }
        return parseComposeStacks(output)
    }

    static func parseContainers(_ raw: String) -> [DockerContainer] {
        raw.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line in
            guard let data = String(line).data(using: .utf8) else { return nil }
            guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return DockerContainer(
                id: (dict["ID"] as? String) ?? "",
                name: (dict["Names"] as? String) ?? "",
                image: (dict["Image"] as? String) ?? "",
                state: ((dict["State"] as? String) ?? "").lowercased(),
                status: (dict["Status"] as? String) ?? "",
                ports: (dict["Ports"] as? String) ?? ""
            )
        }
    }

    static func parseComposeStacks(_ raw: String) -> [DockerComposeStack] {
        guard let data = raw.data(using: .utf8) else { return [] }
        guard let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return arr.map { dict in
            DockerComposeStack(
                name: (dict["Name"] as? String) ?? "",
                status: (dict["Status"] as? String) ?? "",
                configFiles: (dict["ConfigFiles"] as? String) ?? ""
            )
        }
    }

    // MARK: - Compose actions (whole-stack only)

    static func composeUp(file: URL) async throws {
        try await Shell.runCapturingStderrTail(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "up", "-d"],
            currentDirectoryURL: file.deletingLastPathComponent(),
            timeout: 300
        )
    }

    static func composeDown(file: URL) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "down"],
            currentDirectoryURL: file.deletingLastPathComponent(),
            timeout: 60
        )
    }

    static func composeRestart(file: URL) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "restart"],
            currentDirectoryURL: file.deletingLastPathComponent(),
            timeout: 120
        )
    }

    static func composePull(file: URL) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "pull"],
            currentDirectoryURL: file.deletingLastPathComponent(),
            timeout: 300
        )
    }

    // MARK: - Inline (docker run) actions

    /// Container name we use for an inline docker service. Prefixed so we can
    /// recognise our own and avoid collisions with the user's manual containers.
    static func inlineContainerName(_ name: String) -> String { "matisa.\(name)" }

    /// Start an inline container. If a container with the same managed name
    /// exists (stopped), reuse it via `start`; otherwise `run -d`.
    static func inlineRun(image: String, name: String, port: Int) async throws {
        let cname = inlineContainerName(name)
        // If a stopped container with our managed name exists, just start it.
        if let existing = await listContainers().first(where: { $0.name == cname }) {
            if existing.isRunning { return }
            try await Shell.runCapturingStderrTail(
                executable: dockerPath,
                arguments: ["start", cname],
                timeout: 60
            )
            return
        }
        try await Shell.runCapturingStderrTail(
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
        try await Shell.run(
            executable: dockerPath,
            arguments: ["stop", cname],
            timeout: 60
        )
    }

    static func inlineKill(name: String) async throws {
        let cname = inlineContainerName(name)
        try await Shell.run(
            executable: dockerPath,
            arguments: ["kill", cname],
            timeout: 30
        )
    }

    static func inlineRestart(name: String) async throws {
        let cname = inlineContainerName(name)
        try await Shell.run(
            executable: dockerPath,
            arguments: ["restart", cname],
            timeout: 120
        )
    }

    static func inlineRemove(name: String) async throws {
        let cname = inlineContainerName(name)
        try await Shell.run(
            executable: dockerPath,
            arguments: ["rm", "-f", cname],
            timeout: 60
        )
    }

    static func inlinePull(image: String) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["pull", image],
            timeout: 300
        )
    }

    /// Returns true if our managed inline container for `name` is running.
    static func inlineIsRunning(name: String) async -> Bool {
        let cname = inlineContainerName(name)
        return await listContainers().contains(where: { $0.name == cname && $0.isRunning })
    }

    // MARK: - Unmanaged container actions

    /// Start an unmanaged (user-owned) container by raw container name. Unlike
    /// `inline*`, no `matisa.` prefix — the user owns the naming.
    static func unmanagedStart(name: String) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["start", name],
            timeout: 60
        )
    }

    static func unmanagedStop(name: String) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["stop", name],
            timeout: 60
        )
    }

    static func unmanagedKill(name: String) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["kill", name],
            timeout: 30
        )
    }
}
