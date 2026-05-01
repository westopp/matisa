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
        try await Shell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "up", "-d"],
            currentDirectoryURL: file.deletingLastPathComponent()
        )
    }

    static func composeDown(file: URL) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "down"],
            currentDirectoryURL: file.deletingLastPathComponent()
        )
    }

    static func composeRestart(file: URL) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "restart"],
            currentDirectoryURL: file.deletingLastPathComponent()
        )
    }

    static func composePull(file: URL) async throws {
        try await Shell.run(
            executable: dockerPath,
            arguments: ["compose", "-f", file.path, "pull"],
            currentDirectoryURL: file.deletingLastPathComponent()
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
            try await Shell.run(executable: dockerPath, arguments: ["start", cname])
            return
        }
        try await Shell.run(
            executable: dockerPath,
            arguments: [
                "run", "-d",
                "--name", cname,
                "--restart", "unless-stopped",
                "-p", "\(port):\(port)",
                image
            ]
        )
    }

    static func inlineStop(name: String) async throws {
        let cname = inlineContainerName(name)
        try await Shell.run(executable: dockerPath, arguments: ["stop", cname])
    }

    static func inlineRestart(name: String) async throws {
        let cname = inlineContainerName(name)
        try await Shell.run(executable: dockerPath, arguments: ["restart", cname])
    }

    static func inlineRemove(name: String) async throws {
        let cname = inlineContainerName(name)
        try await Shell.run(executable: dockerPath, arguments: ["rm", "-f", cname])
    }

    static func inlinePull(image: String) async throws {
        try await Shell.run(executable: dockerPath, arguments: ["pull", image])
    }

    /// Returns true if our managed inline container for `name` is running.
    static func inlineIsRunning(name: String) async -> Bool {
        let cname = inlineContainerName(name)
        return await listContainers().contains(where: { $0.name == cname && $0.isRunning })
    }
}
