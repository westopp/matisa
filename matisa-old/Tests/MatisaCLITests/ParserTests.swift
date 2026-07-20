import XCTest
@testable import MatisaCLI

/// Coverage for the argv parser. The CLI surface is part of the contract
/// (shell scripts will encode it); these tests pin every command + flag
/// the user can type, including the malformed shapes that should error
/// out with `CLIError.usage`.
final class ParserTests: XCTestCase {

    // MARK: - Subcommand resolution

    func testBareInvocation_returnsHelp() throws {
        let parsed = try Parser.parse([])
        XCTAssertEqual(parsed.command, .help(topic: nil))
    }

    func testListCommand() throws {
        let parsed = try Parser.parse(["list"])
        XCTAssertEqual(parsed.command, .list)
    }

    func testLsAlias() throws {
        let parsed = try Parser.parse(["ls"])
        XCTAssertEqual(parsed.command, .list)
    }

    func testListWithExtraArgs_throws() {
        XCTAssertThrowsError(try Parser.parse(["list", "extra"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testStartCommand() throws {
        let parsed = try Parser.parse(["start", "project:foo"])
        XCTAssertEqual(parsed.command, .start(id: "project:foo"))
    }

    func testStartWithoutID_throws() {
        XCTAssertThrowsError(try Parser.parse(["start"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
            XCTAssertTrue((error as? CLIError)?.message.contains("service-id") ?? false)
        }
    }

    func testStartWithTooManyArgs_throws() {
        XCTAssertThrowsError(try Parser.parse(["start", "a", "b"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testStopCommand() throws {
        let parsed = try Parser.parse(["stop", "project:foo"])
        XCTAssertEqual(parsed.command, .stop(id: "project:foo"))
    }

    func testRestartCommand() throws {
        let parsed = try Parser.parse(["restart", "project:foo"])
        XCTAssertEqual(parsed.command, .restart(id: "project:foo"))
    }

    func testEngineStatus() throws {
        let parsed = try Parser.parse(["engine", "status"])
        XCTAssertEqual(parsed.command, .engineStatus)
    }

    func testEngineStart() throws {
        let parsed = try Parser.parse(["engine", "start"])
        XCTAssertEqual(parsed.command, .engineStart)
    }

    func testEngineStop() throws {
        let parsed = try Parser.parse(["engine", "stop"])
        XCTAssertEqual(parsed.command, .engineStop)
    }

    func testEngineWithoutSubcommand_throws() {
        XCTAssertThrowsError(try Parser.parse(["engine"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testEngineWithUnknownSubcommand_throws() {
        XCTAssertThrowsError(try Parser.parse(["engine", "wat"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testUnknownCommand_throws() {
        XCTAssertThrowsError(try Parser.parse(["foo"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    // MARK: - Help / version

    func testHelpLongFlag() throws {
        let parsed = try Parser.parse(["--help"])
        XCTAssertEqual(parsed.command, .help(topic: nil))
    }

    func testHelpShortFlag() throws {
        let parsed = try Parser.parse(["-h"])
        XCTAssertEqual(parsed.command, .help(topic: nil))
    }

    func testHelpAsCommand() throws {
        let parsed = try Parser.parse(["help"])
        XCTAssertEqual(parsed.command, .help(topic: nil))
    }

    func testHelpWithTopic() throws {
        let parsed = try Parser.parse(["help", "engine"])
        XCTAssertEqual(parsed.command, .help(topic: "engine"))
    }

    func testHelpFlagWithTopic() throws {
        let parsed = try Parser.parse(["--help", "engine"])
        XCTAssertEqual(parsed.command, .help(topic: "engine"))
    }

    func testHelpFlagWinsOverSubcommand() throws {
        // Anywhere --help appears, it wins. Matches conventional CLI UX.
        let parsed = try Parser.parse(["start", "--help", "project:foo"])
        if case .help = parsed.command { } else {
            XCTFail("expected .help, got \(parsed.command)")
        }
    }

    func testVersionLongFlag() throws {
        let parsed = try Parser.parse(["--version"])
        XCTAssertEqual(parsed.command, .version)
    }

    func testVersionShortFlag() throws {
        let parsed = try Parser.parse(["-v"])
        XCTAssertEqual(parsed.command, .version)
    }

    // MARK: - Global flags

    func testSocketFlag_withSpace() throws {
        let parsed = try Parser.parse(["--socket", "/tmp/foo.sock", "list"])
        XCTAssertEqual(parsed.options.socketPath, "/tmp/foo.sock")
        XCTAssertEqual(parsed.command, .list)
    }

    func testSocketFlag_withEquals() throws {
        let parsed = try Parser.parse(["--socket=/tmp/foo.sock", "list"])
        XCTAssertEqual(parsed.options.socketPath, "/tmp/foo.sock")
    }

    func testSocketFlag_withoutValue_throws() {
        XCTAssertThrowsError(try Parser.parse(["--socket"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testEnsureEngineFlag() throws {
        let parsed = try Parser.parse(["--ensure-engine", "list"])
        XCTAssertTrue(parsed.options.ensureEngine)
    }

    func testJsonFlag() throws {
        let parsed = try Parser.parse(["--json", "list"])
        XCTAssertTrue(parsed.options.jsonOutput)
    }

    func testFlagsAfterCommand_stillRecognized() throws {
        // Mixed order: flag after the subcommand and its arg.
        let parsed = try Parser.parse(["start", "project:foo", "--ensure-engine"])
        XCTAssertEqual(parsed.command, .start(id: "project:foo"))
        XCTAssertTrue(parsed.options.ensureEngine)
    }

    func testFlagsBetweenCommandAndArg_stillRecognized() throws {
        let parsed = try Parser.parse(["start", "--ensure-engine", "project:foo"])
        XCTAssertEqual(parsed.command, .start(id: "project:foo"))
        XCTAssertTrue(parsed.options.ensureEngine)
    }

    func testUnknownFlag_throws() {
        XCTAssertThrowsError(try Parser.parse(["--made-up"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    // MARK: - End-of-options separator

    func testDoubleDash_treatsRestAsPositional() throws {
        // After `--`, even things that look like flags are positional. This
        // lets users pass a service id that happens to start with `-`.
        let parsed = try Parser.parse(["start", "--", "--weird-id"])
        XCTAssertEqual(parsed.command, .start(id: "--weird-id"))
    }

    // MARK: - logs subcommand

    func testLogsBare_requiresID() {
        XCTAssertThrowsError(try Parser.parse(["logs"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testLogsDefault_noLinesNoAll() throws {
        let parsed = try Parser.parse(["logs", "project:foo"])
        XCTAssertEqual(parsed.command, .logs(id: "project:foo", lines: nil, all: false))
    }

    func testLogsWithLines() throws {
        let parsed = try Parser.parse(["logs", "project:foo", "--lines", "50"])
        XCTAssertEqual(parsed.command, .logs(id: "project:foo", lines: 50, all: false))
    }

    func testLogsWithShortLines() throws {
        let parsed = try Parser.parse(["logs", "project:foo", "-n", "10"])
        XCTAssertEqual(parsed.command, .logs(id: "project:foo", lines: 10, all: false))
    }

    func testLogsLinesEqualsForm() throws {
        let parsed = try Parser.parse(["logs", "project:foo", "--lines=25"])
        XCTAssertEqual(parsed.command, .logs(id: "project:foo", lines: 25, all: false))
    }

    func testLogsAll() throws {
        let parsed = try Parser.parse(["logs", "project:foo", "--all"])
        XCTAssertEqual(parsed.command, .logs(id: "project:foo", lines: nil, all: true))
    }

    func testLogsAllAndLines_throws() {
        // Mutually exclusive — surfacing the conflict in the parser
        // beats silently honouring one and dropping the other.
        XCTAssertThrowsError(try Parser.parse(["logs", "project:foo", "--all", "--lines", "5"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testLogsLinesNonNumeric_throws() {
        XCTAssertThrowsError(try Parser.parse(["logs", "project:foo", "--lines", "abc"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testLogsLinesNegative_throws() {
        XCTAssertThrowsError(try Parser.parse(["logs", "project:foo", "--lines", "-5"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testLogsTwoIDs_throws() {
        XCTAssertThrowsError(try Parser.parse(["logs", "project:foo", "project:bar"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
        }
    }

    func testLogsUnknownFlag_throws() {
        // `--made-up` survives the global parser as a positional, then the
        // logs parser rejects it with a logs-scoped error message.
        XCTAssertThrowsError(try Parser.parse(["logs", "project:foo", "--made-up"])) { error in
            XCTAssertEqual((error as? CLIError)?.exitCode, 1)
            XCTAssertTrue((error as? CLIError)?.message.contains("logs") ?? false)
        }
    }

    func testLogsWithGlobalJsonFlag() throws {
        // Global --json should still resolve at the global parser level,
        // so the logs parser doesn't see it as a positional.
        let parsed = try Parser.parse(["--json", "logs", "project:foo"])
        XCTAssertEqual(parsed.command, .logs(id: "project:foo", lines: nil, all: false))
        XCTAssertTrue(parsed.options.jsonOutput)
    }
}

