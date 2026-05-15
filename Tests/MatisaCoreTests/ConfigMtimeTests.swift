import XCTest
@testable import MatisaCore

/// Tests the cache-key computation that decides when to re-evaluate the
/// user's `services.ts`. The behaviour we depend on:
///
///   - any change to any `.ts` file under the config dir bumps the value
///     (so per-project files split out under `projects/` invalidate the cache)
///   - non-`.ts` files don't bump it (markdown edits to README are no-ops)
///   - hidden files/dirs are skipped (so `.git` doesn't poison things when
///     the dotfiles are versioned)
///   - missing dirs degrade to a stable sentinel rather than throwing
final class ConfigMtimeTests: XCTestCase {

    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("matisa-mtime-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        try super.tearDownWithError()
    }

    func testReturnsDistantPastForEmptyDir() {
        XCTAssertEqual(ConfigMtime.latest(under: tempDir), .distantPast)
    }

    func testReturnsDistantPastForMissingDir() {
        let missing = tempDir.appendingPathComponent("nope-\(UUID().uuidString)", isDirectory: true)
        XCTAssertEqual(ConfigMtime.latest(under: missing), .distantPast)
    }

    func testReturnsMtimeOfSingleTsFile() throws {
        let file = tempDir.appendingPathComponent("services.ts")
        try "// hi".write(to: file, atomically: true, encoding: .utf8)
        let mtime = try Self.mtime(of: file)
        XCTAssertEqual(ConfigMtime.latest(under: tempDir), mtime)
    }

    func testReturnsMaxAcrossMultipleTsFiles() throws {
        let a = tempDir.appendingPathComponent("a.ts")
        let b = tempDir.appendingPathComponent("b.ts")
        try "a".write(to: a, atomically: true, encoding: .utf8)
        try "b".write(to: b, atomically: true, encoding: .utf8)
        try Self.setMtime(of: a, to: Date(timeIntervalSince1970: 1_000_000))
        try Self.setMtime(of: b, to: Date(timeIntervalSince1970: 2_000_000))
        XCTAssertEqual(
            ConfigMtime.latest(under: tempDir),
            Date(timeIntervalSince1970: 2_000_000)
        )
    }

    func testRecursesIntoSubdirectories() throws {
        let nested = tempDir.appendingPathComponent("projects/portfolio", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        let file = nested.appendingPathComponent("portfolio.ts")
        try "x".write(to: file, atomically: true, encoding: .utf8)
        try Self.setMtime(of: file, to: Date(timeIntervalSince1970: 5_000_000))
        XCTAssertEqual(
            ConfigMtime.latest(under: tempDir),
            Date(timeIntervalSince1970: 5_000_000)
        )
    }

    func testIgnoresNonTsFiles() throws {
        let md = tempDir.appendingPathComponent("README.md")
        let json = tempDir.appendingPathComponent("data.json")
        try "x".write(to: md, atomically: true, encoding: .utf8)
        try "x".write(to: json, atomically: true, encoding: .utf8)
        try Self.setMtime(of: md, to: Date(timeIntervalSince1970: 9_000_000))
        try Self.setMtime(of: json, to: Date(timeIntervalSince1970: 9_000_000))
        XCTAssertEqual(ConfigMtime.latest(under: tempDir), .distantPast)
    }

    func testIgnoresHiddenFiles() throws {
        let hidden = tempDir.appendingPathComponent(".secret.ts")
        try "x".write(to: hidden, atomically: true, encoding: .utf8)
        try Self.setMtime(of: hidden, to: Date(timeIntervalSince1970: 9_000_000))
        XCTAssertEqual(ConfigMtime.latest(under: tempDir), .distantPast)
    }

    func testIgnoresFilesInsideHiddenDirectories() throws {
        let gitDir = tempDir.appendingPathComponent(".git", isDirectory: true)
        try FileManager.default.createDirectory(at: gitDir, withIntermediateDirectories: true)
        let inside = gitDir.appendingPathComponent("HEAD.ts")
        try "x".write(to: inside, atomically: true, encoding: .utf8)
        try Self.setMtime(of: inside, to: Date(timeIntervalSince1970: 9_000_000))
        XCTAssertEqual(ConfigMtime.latest(under: tempDir), .distantPast)
    }

    func testTouchingATsFileBumpsTheResult() throws {
        let file = tempDir.appendingPathComponent("services.ts")
        try "v1".write(to: file, atomically: true, encoding: .utf8)
        try Self.setMtime(of: file, to: Date(timeIntervalSince1970: 1_000_000))
        let before = ConfigMtime.latest(under: tempDir)

        try Self.setMtime(of: file, to: Date(timeIntervalSince1970: 1_500_000))
        let after = ConfigMtime.latest(under: tempDir)

        XCTAssertEqual(before, Date(timeIntervalSince1970: 1_000_000))
        XCTAssertEqual(after, Date(timeIntervalSince1970: 1_500_000))
        XCTAssertNotEqual(before, after)
    }

    // MARK: - helpers

    private static func mtime(of url: URL) throws -> Date {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        return attrs[.modificationDate] as! Date
    }

    private static func setMtime(of url: URL, to date: Date) throws {
        try FileManager.default.setAttributes(
            [.modificationDate: date],
            ofItemAtPath: url.path
        )
    }
}
