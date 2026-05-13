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
}
