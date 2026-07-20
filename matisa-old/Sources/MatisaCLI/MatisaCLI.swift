import Foundation
import MatisaCore

/// `matisa` — command-line client for the Matisa engine. Stateless: every
/// invocation opens a one-shot JSON-RPC connection to the engine's UDS,
/// runs one method, prints the result, exits. No persistent state, no
/// daemonization. The engine's own lifetime is independent — see
/// `matisa engine start/stop` and the `--ensure-engine` flag for the
/// asymmetric "fail loud unless asked" policy from plan.md.
///
/// Exit codes (kept stable across releases so scripts can switch on them):
///   0  success
///   1  usage error (bad args, unknown subcommand)
///   2  engine unreachable / transport failure
///   3  engine returned an RPC error
///   4  spawn / lifecycle failure (engine binary missing, didn't come up)
@main
struct MatisaCLI {

    static func main() async {
        let argv = Array(CommandLine.arguments.dropFirst())

        let parsed: Parsed
        do {
            parsed = try Parser.parse(argv)
        } catch let error as CLIError {
            error.write(to: FileHandle.standardError)
            exit(error.exitCode)
        } catch {
            FileHandle.standardError.write(Data("matisa: \(error)\n".utf8))
            exit(1)
        }

        do {
            try await Runner.run(parsed: parsed)
        } catch let error as CLIError {
            error.write(to: FileHandle.standardError)
            exit(error.exitCode)
        } catch {
            FileHandle.standardError.write(Data("matisa: unexpected error: \(error)\n".utf8))
            exit(1)
        }
    }
}
