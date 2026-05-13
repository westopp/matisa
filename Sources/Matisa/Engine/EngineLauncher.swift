import Foundation
import Darwin
import MatisaCore

/// Locates and starts the matisa-engine binary on behalf of the app.
///
/// The engine is normally spawned by the app at launch if the socket
/// isn't reachable, and is left running detached so it outlives the app
/// (the locked-in design — see plan.md). The launcher only spawns; the
/// engine's own flock on `<sock>.lock` (Server.swift) is the single-
/// instance guard, so spawning is safe even if a race produces two
/// concurrent attempts.
enum EngineLauncher {

    /// Resolution order:
    /// 1. `MATISA_ENGINE_BINARY` — env override, used by tests and as an
    ///    escape hatch for unusual dev setups.
    /// 2. Sibling of the running executable
    ///    (`Contents/MacOS/matisa-engine` inside the shipped `.app`).
    /// 3. `.build/<config>/matisa-engine` for `swift run` dev workflow.
    static func resolveBinaryURL() -> URL? {
        if let envPath = ProcessInfo.processInfo.environment["MATISA_ENGINE_BINARY"],
           !envPath.isEmpty,
           FileManager.default.isExecutableFile(atPath: envPath) {
            return URL(fileURLWithPath: envPath)
        }

        // Sibling of the running executable. Bundle.main resolves to the
        // .app bundle URL for app builds, so we go up to MacOS/ and look
        // for matisa-engine there. For SPM test binaries Bundle.main is
        // the test runner — sibling lookup will miss, which is fine; the
        // .build fallback below kicks in.
        if let exec = Bundle.main.executableURL {
            let sibling = exec
                .deletingLastPathComponent()
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: sibling.path) {
                return sibling
            }
        }

        // .build/<config>/matisa-engine for `swift run` development.
        // CWD when running the app via swift run is the package root.
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for config in ["debug", "release"] {
            let candidate = cwd
                .appendingPathComponent(".build")
                .appendingPathComponent(config)
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }

        return nil
    }

    /// Polls `path` every 50ms for up to `timeout` seconds. Returns true as
    /// soon as a UDS `connect()` to the path succeeds, false on timeout.
    /// Cheap: opens and immediately closes a probe socket per attempt.
    ///
    /// `timeout = 0` is treated as "one immediate probe" rather than "no
    /// probe at all" — callers expecting `isReachableNow()` semantics get
    /// what they expect.
    static func waitForSocketReady(path: String, timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if probeConnect(path: path) {
                return true
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        } while Date() < deadline
        return false
    }

    private static func probeConnect(path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let cap = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < cap else { return false }
        withUnsafeMutablePointer(to: &addr.sun_path) { tup in
            tup.withMemoryRebound(to: UInt8.self, capacity: cap) { bp in
                for (i, b) in bytes.enumerated() { bp[i] = b }
                bp[bytes.count] = 0
            }
        }
        let result = withUnsafePointer(to: &addr) { p -> Int32 in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        return result == 0
    }

    enum LaunchError: Error, CustomStringConvertible {
        case binaryNotFound
        case pathTooLong(String)
        case spawnFailed(Int32, String)
        case didNotComeUp(String)

        var description: String {
            switch self {
            case .binaryNotFound:
                return "matisa-engine binary not found (set MATISA_ENGINE_BINARY or build the app bundle)"
            case .pathTooLong(let p):
                return "socket path too long for sockaddr_un (max 103 bytes incl. NUL): \(p)"
            case .spawnFailed(let code, let msg):
                return "posix_spawn failed rc=\(code): \(msg)"
            case .didNotComeUp(let path):
                return "engine spawned but socket at \(path) never became reachable"
            }
        }
    }

    struct LaunchResult {
        let alreadyRunning: Bool
        let didSpawn: Bool
    }

    /// Ensures the engine is reachable at `socketPath`. If it's not, locates
    /// the binary, spawns it detached, and polls the socket up to `timeout`
    /// seconds for readiness.
    ///
    /// Safe to call concurrently or repeatedly: over-spawn is harmless because
    /// the engine's `flock` on `<sock>.lock` rejects duplicate instances.
    static func ensureRunning(
        socketPath: String,
        timeout: TimeInterval = 5.0
    ) async throws -> LaunchResult {
        // sun_path on Darwin is 104 bytes including the trailing NUL.
        // Catch this here, not after a 5-second timeout-with-redirected-stderr.
        guard socketPath.utf8.count < 104 else {
            throw LaunchError.pathTooLong(socketPath)
        }

        if probeConnect(path: socketPath) {
            return LaunchResult(alreadyRunning: true, didSpawn: false)
        }

        guard let binary = resolveBinaryURL() else {
            throw LaunchError.binaryNotFound
        }

        try spawnDetached(binary: binary)

        if await waitForSocketReady(path: socketPath, timeout: timeout) {
            return LaunchResult(alreadyRunning: false, didSpawn: true)
        }
        throw LaunchError.didNotComeUp(socketPath)
    }

    /// posix_spawn the engine in its own session so it survives the app.
    /// stdin is /dev/null; stdout and stderr are redirected to
    /// `~/Library/Logs/Matisa/engine.log` (append, mode 0600) so any
    /// startup diagnostics — bind failures, flock contention, accept-loop
    /// errors — land somewhere the user can recover them.
    private static func spawnDetached(binary: URL) throws {
        var fileActions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        // stdin is harmless to discard. stdout and stderr go to the engine's
        // log file so startup diagnostics (path-too-long, flock contention,
        // bind EADDRINUSE, accept errors) are recoverable — discarding them
        // turns a 5-second timeout into an opaque mystery.
        posix_spawn_file_actions_addopen(&fileActions, 0, "/dev/null", O_RDONLY, 0)
        let logPath = CorePaths.logsDir.appendingPathComponent("engine.log").path
        posix_spawn_file_actions_addopen(
            &fileActions, 1, logPath,
            O_WRONLY | O_APPEND | O_CREAT, 0o600
        )
        posix_spawn_file_actions_addopen(
            &fileActions, 2, logPath,
            O_WRONLY | O_APPEND | O_CREAT, 0o600
        )

        var attr: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // SETSID: new session, detached from app's controlling terminal /
        // process group. When the app quits, the engine survives and is
        // reparented to launchd.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID))

        // Inherit the user's environment so the engine sees PATH etc.
        let env = ProcessInfo.processInfo.environment
        let envStrings: [String] = env.map { "\($0.key)=\($0.value)" }
        let envCArray = envStrings.map { strdup($0) }
        defer { envCArray.forEach { free($0) } }
        var envPtrs: [UnsafeMutablePointer<CChar>?] = envCArray + [nil]

        let argv: [UnsafeMutablePointer<CChar>?] = [
            strdup(binary.path),
            nil
        ]
        defer { argv.forEach { if let p = $0 { free(p) } } }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, binary.path, &fileActions, &attr,
                             argv, &envPtrs)
        if rc != 0 {
            throw LaunchError.spawnFailed(
                rc,
                String(cString: strerror(rc))
            )
        }
        // Deliberately don't wait — the engine is meant to outlive us.
    }
}
