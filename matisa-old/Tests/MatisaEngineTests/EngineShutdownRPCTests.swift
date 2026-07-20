import XCTest
import Foundation
@testable import MatisaEngine

/// Black-box test: spawn the built matisa-engine binary as a child process,
/// connect to its socket, send engine.shutdown, and verify the process
/// exits cleanly within a few seconds. Reuses the same MATISA_SOCKET
/// override pattern as the rest of the test suite.
final class EngineShutdownRPCTests: XCTestCase {

    /// Locate the matisa-engine binary built by `swift test` / `swift build`.
    /// Falls back to .build/<config>/matisa-engine relative to the package root.
    private func engineBinaryURL() -> URL? {
        // `swift test` sets the working directory to the package root.
        let pkgRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for config in ["debug", "release"] {
            let candidate = pkgRoot
                .appendingPathComponent(".build")
                .appendingPathComponent(config)
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
            // Universal-build layout: .build/apple/Products/<Config>/matisa-engine
            let universal = pkgRoot
                .appendingPathComponent(".build/apple/Products")
                .appendingPathComponent(config.capitalized)
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: universal.path) {
                return universal
            }
        }
        return nil
    }

    func testShutdownRPCExitsTheEngineCleanly() throws {
        guard let binary = engineBinaryURL() else {
            throw XCTSkip("matisa-engine binary not built yet")
        }

        let sockPath = NSTemporaryDirectory()
            + "matisa-test-\(UUID().uuidString).sock"
        let lockPath = sockPath + ".lock"
        defer {
            unlink(sockPath)
            unlink(lockPath)
        }

        let proc = Process()
        proc.executableURL = binary
        proc.environment = ["MATISA_SOCKET": sockPath]
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try proc.run()

        // Wait for socket to appear (up to 3s).
        let deadline = Date().addingTimeInterval(3.0)
        while !FileManager.default.fileExists(atPath: sockPath) {
            if Date() > deadline {
                proc.terminate()
                XCTFail("engine never created socket at \(sockPath)")
                return
            }
            usleep(50_000)
        }

        // Send engine.shutdown.
        let request = #"{"jsonrpc":"2.0","method":"engine.shutdown","id":1}"# + "\n"
        let response = try sendOverUDS(socketPath: sockPath, line: request)
        XCTAssertTrue(response.contains("\"result\""),
                      "expected success response, got: \(response)")

        // Engine should exit within ~1s after acking shutdown.
        let exitDeadline = Date().addingTimeInterval(2.0)
        while proc.isRunning {
            if Date() > exitDeadline {
                proc.terminate()
                XCTFail("engine did not exit after engine.shutdown")
                return
            }
            usleep(50_000)
        }
        XCTAssertEqual(proc.terminationStatus, 0,
                       "engine exit status should be 0, got \(proc.terminationStatus)")
    }

    /// One-shot send: open UDS, write one line, read one line, close.
    private func sendOverUDS(socketPath: String, line: String) throws -> String {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NSError(domain: "uds", code: Int(errno)) }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        withUnsafeMutablePointer(to: &addr.sun_path) { tup in
            tup.withMemoryRebound(to: UInt8.self, capacity: capacity) { bp in
                for (i, b) in pathBytes.enumerated() { bp[i] = b }
                bp[pathBytes.count] = 0
            }
        }
        let connectResult = withUnsafePointer(to: &addr) { p -> Int32 in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectResult == 0 else {
            throw NSError(domain: "uds-connect", code: Int(errno))
        }

        let data = Array(line.utf8)
        _ = data.withUnsafeBufferPointer { buf in
            write(fd, buf.baseAddress, buf.count)
        }

        var out = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = chunk.withUnsafeMutableBufferPointer { b in
                read(fd, b.baseAddress, b.count)
            }
            if n <= 0 { break }
            out.append(contentsOf: chunk[..<n])
            if out.contains(0x0A) { break }
        }
        return String(data: out, encoding: .utf8) ?? ""
    }
}
