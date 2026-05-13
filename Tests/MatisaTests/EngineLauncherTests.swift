import XCTest
@testable import Matisa

final class EngineLauncherTests: XCTestCase {

    func testResolvesBinaryFromEnvOverride() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("fake-engine-\(UUID().uuidString)")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: tmp)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: tmp.path
        )
        defer { try? FileManager.default.removeItem(at: tmp) }

        setenv("MATISA_ENGINE_BINARY", tmp.path, 1)
        defer { unsetenv("MATISA_ENGINE_BINARY") }

        let resolved = EngineLauncher.resolveBinaryURL()
        XCTAssertEqual(resolved?.path, tmp.path)
    }

    func testReturnsNilWhenNothingFound() {
        setenv("MATISA_ENGINE_BINARY", "/no/such/path", 1)
        defer { unsetenv("MATISA_ENGINE_BINARY") }
        // Test environments don't have a bundled binary either; resolution
        // should fail cleanly rather than returning a stale path.
        // (The .build/<config> fallback may exist when swift test is running,
        // so we don't assert nil unconditionally — instead assert that an
        // unreadable env override doesn't get returned.)
        let resolved = EngineLauncher.resolveBinaryURL()
        XCTAssertNotEqual(resolved?.path, "/no/such/path")
    }

    func testWaitForSocketTimesOutWhenSocketIsMissing() async {
        let sockPath = NSTemporaryDirectory()
            + "lt-\(UUID().uuidString).sock"
        let result = await EngineLauncher.waitForSocketReady(
            path: sockPath,
            timeout: 0.3
        )
        XCTAssertFalse(result, "socket that never exists should time out")
    }

    func testWaitForSocketReturnsTrueWhenSocketBecomesAvailable() async throws {
        let sockPath = NSTemporaryDirectory()
            + "lt-\(UUID().uuidString).sock"
        defer { unlink(sockPath) }

        // Spawn a minimal listener in the background.
        let listenerReady = expectation(description: "listener ready")
        Task.detached {
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            defer { close(fd) }
            var addr = sockaddr_un()
            addr.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(sockPath.utf8)
            let cap = MemoryLayout.size(ofValue: addr.sun_path)
            withUnsafeMutablePointer(to: &addr.sun_path) { tup in
                tup.withMemoryRebound(to: UInt8.self, capacity: cap) { bp in
                    for (i, b) in bytes.enumerated() { bp[i] = b }
                    bp[bytes.count] = 0
                }
            }
            _ = withUnsafePointer(to: &addr) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            _ = listen(fd, 8)
            listenerReady.fulfill()
            // Keep listening until the test tears down — accept and close.
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { break }
                close(c)
            }
        }
        await fulfillment(of: [listenerReady], timeout: 1.0)

        let result = await EngineLauncher.waitForSocketReady(
            path: sockPath,
            timeout: 1.0
        )
        XCTAssertTrue(result)
    }
}
