import Foundation
import Darwin

/// Async shell helpers used by the engine's lifecycle layer. The discovery
/// probes (`SyncShell`) are intentionally sync and call sites are short, but
/// lifecycle operations like `docker compose up` can take minutes — pinning
/// one of the cooperative pool's threads for that long isn't acceptable.
/// Each call is wrapped in `Task.detached` so the underlying `Process.run` +
/// `waitUntilExit` blocking happens on a thread the runtime is happy to lose.
///
/// Implementations are byte-identical to the app's `Sources/Matisa/Supervisor/Shell.swift`
/// — same timeout escalation (SIGTERM → 2s grace → SIGKILL), same stderr-tail
/// capture for compose-style commands. Kept separate (rather than reused from
/// MatisaCore) because the engine and app deliberately don't share a
/// supervisor today; a future cleanup can promote `Shell` + `ShellError` into
/// MatisaCore once both targets are happy with one shape.
enum EngineShell {
    /// Run a process and capture stdout, throwing on non-zero exit.
    static func runCapturing(
        executable: String,
        arguments: [String],
        currentDirectoryURL: URL? = nil,
        environment: [String: String]? = nil
    ) async throws -> String {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            if let cwd = currentDirectoryURL { process.currentDirectoryURL = cwd }
            if let env = environment { process.environment = env }

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            try process.run()
            process.waitUntilExit()

            let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
            let stderr = String(data: stderrData, encoding: .utf8) ?? ""

            if process.terminationStatus != 0 {
                throw ShellError.nonZeroExit(code: process.terminationStatus, stderr: stderr)
            }
            return stdout
        }.value
    }

    /// Run a process and return the exit code without capturing output.
    /// stdout/stderr are routed to /dev/null so chatty children (e.g. compose
    /// pull progress) can never deadlock by filling an inherited pipe.
    /// When `timeout` is set, the child is SIGTERM'd after the deadline and,
    /// if it doesn't exit within 2s, SIGKILL'd; `ShellError.timedOut` is then
    /// thrown. Guards against stuck daemons that ignore catchable signals.
    @discardableResult
    static func run(
        executable: String,
        arguments: [String],
        currentDirectoryURL: URL? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> Int32 {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            if let cwd = currentDirectoryURL { process.currentDirectoryURL = cwd }
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()

            if let timeout {
                let deadline = Date().addingTimeInterval(timeout)
                while process.isRunning {
                    if Date() >= deadline {
                        process.terminate()
                        // Give SIGTERM a moment to land before escalating.
                        let killBy = Date().addingTimeInterval(2)
                        while process.isRunning && Date() < killBy {
                            try? await Task.sleep(nanoseconds: 50_000_000)
                        }
                        if process.isRunning {
                            // SIGKILL is uncatchable; the child *will* die.
                            // Poll for reaping rather than `waitUntilExit()`
                            // so we never block this Task's underlying thread.
                            Darwin.kill(process.processIdentifier, SIGKILL)
                            while process.isRunning {
                                try? await Task.sleep(nanoseconds: 50_000_000)
                            }
                        }
                        throw ShellError.timedOut(after: timeout)
                    }
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
            } else {
                process.waitUntilExit()
            }
            return process.terminationStatus
        }.value
    }

    /// Run a process while capturing the tail of its stderr. Stdout still
    /// goes to /dev/null (callers don't care about it and chatty stdout
    /// risks pipe deadlock). Stderr is routed to a temp file — kernel
    /// buffered, no pipe-back-pressure regardless of how much progress the
    /// child writes (e.g. `docker compose pull` streams MBs of output).
    /// On non-zero exit, throws `ShellError.nonZeroExit(code, stderr: tail)`
    /// with up to `tailMaxBytes` of the *last* bytes written. On timeout,
    /// throws `ShellError.timedOut(after:)` (after the same SIGTERM/SIGKILL
    /// escalation as `EngineShell.run`).
    @discardableResult
    static func runCapturingStderrTail(
        executable: String,
        arguments: [String],
        currentDirectoryURL: URL? = nil,
        timeout: TimeInterval? = nil,
        tailMaxBytes: Int = 8192
    ) async throws -> Int32 {
        try await Task.detached {
            let tempURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("matisa-stderr-\(UUID().uuidString).log")
            guard FileManager.default.createFile(atPath: tempURL.path, contents: nil) else {
                throw ShellError.spawnFailed("could not create temp stderr file")
            }
            let writer: FileHandle
            do {
                writer = try FileHandle(forWritingTo: tempURL)
            } catch {
                try? FileManager.default.removeItem(at: tempURL)
                throw ShellError.spawnFailed(String(describing: error))
            }
            // Always best-effort cleanup — `defer` is the only path we trust
            // to fire even if a `throw` happens mid-way.
            func cleanup() {
                try? writer.close()
                try? FileManager.default.removeItem(at: tempURL)
            }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            if let cwd = currentDirectoryURL { process.currentDirectoryURL = cwd }
            process.standardOutput = FileHandle.nullDevice
            process.standardError = writer

            do {
                try process.run()
            } catch {
                cleanup()
                throw ShellError.spawnFailed(String(describing: error))
            }

            if let timeout {
                let deadline = Date().addingTimeInterval(timeout)
                while process.isRunning {
                    if Date() >= deadline {
                        process.terminate()
                        let killBy = Date().addingTimeInterval(2)
                        while process.isRunning && Date() < killBy {
                            try? await Task.sleep(nanoseconds: 50_000_000)
                        }
                        if process.isRunning {
                            Darwin.kill(process.processIdentifier, SIGKILL)
                            while process.isRunning {
                                try? await Task.sleep(nanoseconds: 50_000_000)
                            }
                        }
                        cleanup()
                        throw ShellError.timedOut(after: timeout)
                    }
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
            } else {
                process.waitUntilExit()
            }

            let code = process.terminationStatus
            // Close the writer before reading to make sure all buffered
            // child output has hit the file.
            try? writer.close()

            if code != 0 {
                let tail = readTail(of: tempURL, maxBytes: tailMaxBytes)
                try? FileManager.default.removeItem(at: tempURL)
                throw ShellError.nonZeroExit(code: code, stderr: tail)
            }
            try? FileManager.default.removeItem(at: tempURL)
            return code
        }.value
    }

    /// Read the last `maxBytes` of `url` as UTF-8. Returns "" on any error.
    private static func readTail(of url: URL, maxBytes: Int) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        do {
            let size = try handle.seekToEnd()
            let offset = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
            try handle.seek(toOffset: offset)
            let data = handle.readDataToEndOfFile()
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }
}

/// Engine-local twin of the app's `ShellError`. Kept separate from the app's
/// copy for now — both targets evolved their own and we don't want to drag
/// the supervisor into MatisaCore in this slice. Future cleanup candidate:
/// promote one canonical `ShellError` into MatisaCore.
enum ShellError: Error, CustomStringConvertible {
    case nonZeroExit(code: Int32, stderr: String)
    case spawnFailed(String)
    case timedOut(after: TimeInterval)

    var description: String {
        switch self {
        case .nonZeroExit(let code, let stderr):
            return "exit \(code): \(stderr)"
        case .spawnFailed(let msg):
            return "spawn failed: \(msg)"
        case .timedOut(let after):
            return "timed out after \(after)s"
        }
    }
}
