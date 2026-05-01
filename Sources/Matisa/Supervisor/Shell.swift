import Foundation

enum ShellError: Error, CustomStringConvertible {
    case nonZeroExit(code: Int32, stderr: String)
    case spawnFailed(String)

    var description: String {
        switch self {
        case .nonZeroExit(let code, let stderr):
            return "exit \(code): \(stderr)"
        case .spawnFailed(let msg):
            return "spawn failed: \(msg)"
        }
    }
}

enum Shell {
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
    @discardableResult
    static func run(
        executable: String,
        arguments: [String],
        currentDirectoryURL: URL? = nil
    ) async throws -> Int32 {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            if let cwd = currentDirectoryURL { process.currentDirectoryURL = cwd }
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        }.value
    }

    /// Locate an executable. Checks well-known dev paths, then asks a login
    /// zsh (which inherits the user's PATH from .zshrc/.zprofile, picking up
    /// nvm/fnm/bun/cargo etc).
    static func which(_ name: String) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
            "\(home)/.bun/bin/\(name)",
            "\(home)/.cargo/bin/\(name)",
            "\(home)/.local/bin/\(name)",
            "/usr/bin/\(name)",
            "/bin/\(name)"
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        // Fallback: login zsh so we pick up the user's PATH.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-l", "-c", "command -v \(name)"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let result = (String(data: data, encoding: .utf8) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return result.isEmpty ? nil : result
        } catch {
            return nil
        }
    }
}
