import Foundation
import MatisaCore

enum Lsof {
    /// Run `lsof -iTCP -sTCP:LISTEN -nP -F pcn` and parse the result.
    /// The shape and parsing live in MatisaCore so the engine can use the
    /// same code; this remains the app's async wrapper around it.
    static func listening() async throws -> [ListeningPort] {
        let output = try await Shell.runCapturing(
            executable: "/usr/sbin/lsof",
            arguments: ["-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn"]
        )
        return LsofParser.parse(output)
    }

    /// Re-export of the MatisaCore parser so the existing test still finds it.
    /// Will go away once the test moves to MatisaCoreTests.
    static func parse(_ raw: String) -> [ListeningPort] {
        LsofParser.parse(raw)
    }

    static func portFromAddress(_ address: String) -> Int? {
        LsofParser.portFromAddress(address)
    }
}
