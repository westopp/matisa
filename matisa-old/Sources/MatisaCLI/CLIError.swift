import Foundation

/// Single error type the CLI throws everywhere. Carries an exit code and a
/// human-readable message; `write(to:)` formats both to stderr in a
/// recognisable `matisa: …` style.
///
/// Exit codes are part of the wire contract for shell scripts — bumping or
/// reassigning them is a breaking change. See `MatisaCLI.main` for the list.
struct CLIError: Error {
    let exitCode: Int32
    let message: String

    init(exitCode: Int32, message: String) {
        self.exitCode = exitCode
        self.message = message
    }

    static func usage(_ message: String) -> CLIError {
        CLIError(exitCode: 1, message: message)
    }

    static func unreachable(_ message: String) -> CLIError {
        CLIError(exitCode: 2, message: message)
    }

    static func rpc(code: Int, message: String) -> CLIError {
        CLIError(exitCode: 3, message: "engine rpc error \(code): \(message)")
    }

    static func spawn(_ message: String) -> CLIError {
        CLIError(exitCode: 4, message: message)
    }

    func write(to handle: FileHandle) {
        handle.write(Data("matisa: \(message)\n".utf8))
    }
}
