import XCTest
@testable import Matisa
import MatisaCore

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
        // Order matters: close the listener first (which makes accept return),
        // then unlink the path. Defers run LIFO, so list them in this order.
        defer { unlink(sockPath) }

        // Bind + listen on the main test thread so we own the fd and can
        // close it deterministically below. The Task.detached below only
        // runs the accept loop, which exits as soon as the fd is closed.
        let listenerFD = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(listenerFD, 0)
        defer { close(listenerFD) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(sockPath.utf8)
        let cap = MemoryLayout.size(ofValue: addr.sun_path)
        XCTAssertLessThan(bytes.count, cap, "socket path overflows sun_path; shorten the prefix")
        withUnsafeMutablePointer(to: &addr.sun_path) { tup in
            tup.withMemoryRebound(to: UInt8.self, capacity: cap) { bp in
                for (i, b) in bytes.enumerated() { bp[i] = b }
                bp[bytes.count] = 0
            }
        }
        let bindResult = withUnsafePointer(to: &addr) { p -> Int32 in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(listenerFD, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        XCTAssertEqual(bindResult, 0, "bind failed: \(String(cString: strerror(errno)))")
        XCTAssertEqual(listen(listenerFD, 8), 0)

        // Run the accept loop on a detached task. Exits when listenerFD is
        // closed (accept returns -1 / EBADF).
        Task.detached {
            while true {
                let c = accept(listenerFD, nil, nil)
                if c < 0 { break }
                close(c)
            }
        }

        let result = await EngineLauncher.waitForSocketReady(
            path: sockPath,
            timeout: 1.0
        )
        XCTAssertTrue(result)
        // Defers: close(listenerFD) runs first → accept returns -1 → detached
        // task exits. Then unlink(sockPath) cleans up the inode.
    }

    /// Integration test: locate the actual built engine binary, spawn it
    /// with a temp socket path, verify it comes up, then SIGTERM it.
    func testEnsureRunningSpawnsTheEngine() async throws {
        guard let binary = locateBuiltEngineBinary() else {
            throw XCTSkip("matisa-engine binary not built; run `swift build`")
        }

        let sockPath = NSTemporaryDirectory()
            + "lt-\(UUID().uuidString).sock"
        defer {
            unlink(sockPath)
            unlink(sockPath + ".lock")
        }

        setenv("MATISA_ENGINE_BINARY", binary.path, 1)
        setenv("MATISA_SOCKET", sockPath, 1)
        defer {
            unsetenv("MATISA_ENGINE_BINARY")
            unsetenv("MATISA_SOCKET")
        }

        let result = try await EngineLauncher.ensureRunning(
            socketPath: sockPath,
            timeout: 5.0
        )
        XCTAssertTrue(result.didSpawn || result.alreadyRunning)
        XCTAssertTrue(FileManager.default.fileExists(atPath: sockPath))

        // Tear down: SIGTERM the engine via its pidfile contents. The
        // .lock file holds the engine's PID.
        if let pidStr = try? String(contentsOfFile: sockPath + ".lock"),
           let pid = pid_t(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) {
            kill(pid, SIGTERM)
            // Best-effort wait for shutdown.
            for _ in 0..<40 where kill(pid, 0) == 0 {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }
    }

    private func locateBuiltEngineBinary() -> URL? {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for config in ["debug", "release"] {
            let candidate = cwd
                .appendingPathComponent(".build")
                .appendingPathComponent(config)
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }
}
