import Foundation
import MatisaCore

/// Sync ports of the app's discovery probes. Same shell-outs, same parsing
/// (delegated to MatisaCore parsers), just without the `async` wrappers.
/// Used by `DiscoveryService` to build a snapshot in response to one
/// `discovery.snapshot` RPC.

enum SyncLsof {
    static func listening() -> [ListeningPort] {
        let r = SyncShell.runCapturing(
            executable: "/usr/sbin/lsof",
            arguments: ["-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn"]
        )
        // lsof returns 1 when nothing matches, which is normal — only treat
        // a totally-empty output as "no data".
        let raw = String(data: r.stdout, encoding: .utf8) ?? ""
        return LsofParser.parse(raw)
    }
}

enum SyncDocker {
    static var dockerPath: String {
        SyncShell.which("docker") ?? "/usr/local/bin/docker"
    }

    /// Cheap probe: `docker info -f '{{.ServerVersion}}'` returns 0 only when
    /// the daemon is reachable. Short timeout prevents the probe itself from
    /// hanging if the socket exists but nobody's listening.
    static func daemonRunning(timeout: TimeInterval = 3) -> Bool {
        let r = SyncShell.runCapturing(
            executable: dockerPath,
            arguments: ["info", "-f", "{{.ServerVersion}}"],
            timeout: timeout
        )
        return r.exitCode == 0
    }

    static func listContainers() -> [DockerContainer] {
        let r = SyncShell.runCapturing(
            executable: dockerPath,
            arguments: ["ps", "-a", "--format", "{{json .}}"],
            timeout: 10
        )
        guard r.exitCode == 0 else { return [] }
        return DockerJSONParser.parseContainers(String(data: r.stdout, encoding: .utf8) ?? "")
    }

    static func listComposeStacks() -> [DockerComposeStack] {
        let r = SyncShell.runCapturing(
            executable: dockerPath,
            arguments: ["compose", "ls", "--all", "--format", "json"],
            timeout: 10
        )
        guard r.exitCode == 0 else { return [] }
        return DockerJSONParser.parseComposeStacks(String(data: r.stdout, encoding: .utf8) ?? "")
    }
}

enum SyncBrew {
    static var brewPath: String {
        SyncShell.which("brew") ?? "/opt/homebrew/bin/brew"
    }

    static func list() -> [BrewService] {
        let r = SyncShell.runCapturing(
            executable: brewPath,
            arguments: ["services", "list", "--json"],
            timeout: 10
        )
        guard r.exitCode == 0 else { return [] }
        return BrewJSONParser.parse(String(data: r.stdout, encoding: .utf8) ?? "")
    }
}
