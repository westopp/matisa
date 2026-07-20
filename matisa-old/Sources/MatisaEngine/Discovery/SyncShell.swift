import Foundation
import Darwin

/// Synchronous shell-out helper. The engine's dispatcher is sync; the
/// underlying probes (`lsof`, `docker ps`, `brew services list`) are POSIX
/// `Process`-based and don't actually need Swift concurrency. Each call
/// blocks the calling worker queue thread but never the rest of the engine,
/// since connection workers run on their own concurrent queue.
enum SyncShell {

    struct Result {
        let exitCode: Int32
        let stdout: Data
        let stderr: String
    }

    /// Run a process to completion, capturing stdout and stderr. On timeout
    /// SIGTERMs the child, escalates to SIGKILL after 1s if it lingers.
    static func runCapturing(
        executable: String,
        arguments: [String],
        timeout: TimeInterval? = nil
    ) -> Result {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return Result(exitCode: -1, stdout: Data(), stderr: "spawn failed: \(error)")
        }

        if let timeout {
            let deadline = Date().addingTimeInterval(timeout)
            while process.isRunning {
                if Date() >= deadline {
                    process.terminate()
                    let killBy = Date().addingTimeInterval(1)
                    while process.isRunning && Date() < killBy {
                        Thread.sleep(forTimeInterval: 0.05)
                    }
                    if process.isRunning {
                        Darwin.kill(process.processIdentifier, SIGKILL)
                        while process.isRunning {
                            Thread.sleep(forTimeInterval: 0.05)
                        }
                    }
                    break
                }
                Thread.sleep(forTimeInterval: 0.05)
            }
        } else {
            process.waitUntilExit()
        }

        let stdout = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        return Result(
            exitCode: process.terminationStatus,
            stdout: stdout,
            stderr: String(data: stderrData, encoding: .utf8) ?? ""
        )
    }

    /// Locate an executable. Mirrors the app's `Shell.which` resolution order:
    /// well-known dev paths first, then an interactive login zsh that picks
    /// up the user's PATH from `.zshrc` + `.zprofile` (nvm/fnm/bun/cargo etc).
    /// `-i` is required because most installers (bun, nvm, fnm, pnpm) write
    /// their PATH setup to `.zshrc`, which a non-interactive shell skips.
    static func which(_ name: String) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
            "\(home)/.bun/bin/\(name)",
            "\(home)/.cargo/bin/\(name)",
            "\(home)/.local/bin/\(name)",
            "/usr/bin/\(name)",
            "/bin/\(name)",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        let r = runCapturing(
            executable: "/bin/zsh",
            arguments: ["-i", "-l", "-c", "command -v \(name)"]
        )
        let out = (String(data: r.stdout, encoding: .utf8) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return out.isEmpty ? nil : out
    }
}
