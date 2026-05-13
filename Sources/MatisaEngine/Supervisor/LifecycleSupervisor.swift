import Foundation
import Darwin
import MatisaCore

/// Engine-side port of the app's `ProcessSupervisor`. Spawns dev commands as
/// detached, session-leader processes that survive the engine exiting. Uses
/// `posix_spawn` with `POSIX_SPAWN_SETSID` plus a login zsh wrapper so the
/// spawned process inherits the user's PATH.
///
/// The app's `ProcessSupervisor` still exists today; once Phase 2c.3 wires
/// the app to RPC handlers it'll become the local-fallback path. Both stay
/// in sync until then.
enum LifecycleSupervisor {

    struct SpawnResult {
        let pid: pid_t
        let logURL: URL
    }

    /// Spawn a detached process. Returns the PID once the kernel hands it back.
    /// Stdout + stderr are appended to `logURL`; stdin from /dev/null.
    /// `extraEnv` overrides any keys inherited from the engine's process env.
    static func spawnDetached(
        shellCommand: String,
        workingDirectory: URL,
        serviceID: String,
        extraEnv: [String: String] = [:]
    ) throws -> SpawnResult {
        let logURL = CorePaths.logFile(for: serviceID)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }

        // Belt and braces: `cd` inside the wrapper as well as posix_spawn's
        // addchdir_np, since the latter has been observed to silently no-op
        // in some sandboxes. `exec` swaps the shell for the dev command so
        // the captured PID is the dev command's, not the wrapper shell's.
        // The diagnostic preamble gives us a fighting chance of debugging
        // PATH / cwd issues if the dev command can't even start.
        let cwdEscaped = workingDirectory.path.replacingOccurrences(of: "'", with: "'\\''")
        let wrapper = "cd '\(cwdEscaped)' && exec \(shellCommand)"
        let shellPath = "/bin/zsh"
        let argv: [String] = [shellPath, "-l", "-c", wrapper]

        var fileActions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }

        posix_spawn_file_actions_addopen(&fileActions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(
            &fileActions, 1, logURL.path,
            O_WRONLY | O_APPEND | O_CREAT,
            0o644
        )
        posix_spawn_file_actions_adddup2(&fileActions, 1, 2)
        posix_spawn_file_actions_addchdir_np(&fileActions, workingDirectory.path)

        var attr: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        let flags: Int16 = Int16(POSIX_SPAWN_SETSID)
        posix_spawnattr_setflags(&attr, flags)

        let cArgv: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
        defer { for p in cArgv { free(p) } }

        // Hint to most CLIs that they should emit ANSI colors even though
        // their stdout is a pipe rather than a TTY. Covered by FORCE_COLOR
        // (Node tooling), CLICOLOR_FORCE (BSD ls and friends), and a
        // 256-color TERM (anything that sniffs the terminfo entry).
        var env = ProcessInfo.processInfo.environment
        env["FORCE_COLOR"] = env["FORCE_COLOR"] ?? "1"
        env["CLICOLOR_FORCE"] = env["CLICOLOR_FORCE"] ?? "1"
        env["TERM"] = env["TERM"] ?? "xterm-256color"
        // User-declared env wins over the inherited values.
        for (k, v) in extraEnv { env[k] = v }
        let envStrings = env.map { "\($0.key)=\($0.value)" }
        let cEnvp: [UnsafeMutablePointer<CChar>?] = envStrings.map { strdup($0) } + [nil]
        defer { for p in cEnvp { free(p) } }

        var pid: pid_t = 0
        let rc = cArgv.withUnsafeBufferPointer { argvBuf in
            cEnvp.withUnsafeBufferPointer { envpBuf in
                posix_spawn(
                    &pid,
                    shellPath,
                    &fileActions,
                    &attr,
                    UnsafeMutablePointer(mutating: argvBuf.baseAddress),
                    UnsafeMutablePointer(mutating: envpBuf.baseAddress)
                )
            }
        }

        if rc != 0 {
            throw ShellError.spawnFailed("posix_spawn rc=\(rc): \(String(cString: strerror(rc)))")
        }
        return SpawnResult(pid: pid, logURL: logURL)
    }

    /// SIGTERM the process group (use the spawn pid which is the session leader).
    @discardableResult
    static func stop(pid: pid_t) -> Bool {
        let rc = killpg(pid, SIGTERM)
        if rc != 0 && errno == ESRCH { return false }
        return rc == 0
    }

    /// SIGKILL the process group.
    @discardableResult
    static func forceKill(pid: pid_t) -> Bool {
        let rc = killpg(pid, SIGKILL)
        if rc != 0 && errno == ESRCH { return false }
        return rc == 0
    }

    /// Stop a foreign PID we didn't spawn — likely not a session leader, so
    /// signal the PID directly rather than the group.
    @discardableResult
    static func stopForeign(pid: pid_t) -> Bool {
        let rc = Darwin.kill(pid, SIGTERM)
        if rc != 0 && errno == ESRCH { return false }
        return rc == 0
    }

    @discardableResult
    static func killForeign(pid: pid_t) -> Bool {
        let rc = Darwin.kill(pid, SIGKILL)
        if rc != 0 && errno == ESRCH { return false }
        return rc == 0
    }

    /// True when `pid` exists (or exists but we lack permission to signal it).
    /// Delegates to `SyncProcess.isAlive` so engine code has one liveness
    /// helper rather than two.
    static func isAlive(pid: pid_t) -> Bool {
        SyncProcess.isAlive(pid: pid)
    }

    /// Stop with auto-escalation: SIGTERM, wait up to `gracefulSeconds`, then
    /// SIGKILL if still alive. Use `foreign: true` for processes we didn't spawn.
    static func stopWithEscalation(pid: pid_t, gracefulSeconds: Double = 5, foreign: Bool = false) async {
        if foreign { _ = stopForeign(pid: pid) } else { _ = stop(pid: pid) }
        let stepNs: UInt64 = 250_000_000
        let steps = Int((gracefulSeconds * 1_000_000_000) / Double(stepNs))
        for _ in 0..<steps {
            try? await Task.sleep(nanoseconds: stepNs)
            if !isAlive(pid: pid) { return }
        }
        if foreign { _ = killForeign(pid: pid) } else { _ = forceKill(pid: pid) }
    }
}
