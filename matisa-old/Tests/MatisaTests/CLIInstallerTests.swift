import XCTest
@testable import Matisa

/// Exercises the state-detection arms and the create / remove pair against
/// a controllable tmpdir. We pass mock paths via the test-only overloads
/// so the real `/usr/local/bin/matisa` symlink stays untouched.
final class CLIInstallerTests: XCTestCase {

    private var tmpRoot: URL!
    private var fakeBundleCLI: URL!
    private var fakeSymlink: URL!

    override func setUpWithError() throws {
        tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("cli-installer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)

        fakeBundleCLI = tmpRoot.appendingPathComponent("Matisa.app/Contents/Resources/bin/matisa")
        try FileManager.default.createDirectory(
            at: fakeBundleCLI.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: fakeBundleCLI)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: fakeBundleCLI.path
        )

        fakeSymlink = tmpRoot.appendingPathComponent("usr-local-bin/matisa")
        try FileManager.default.createDirectory(
            at: fakeSymlink.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpRoot)
    }

    // MARK: - state()

    func testState_notInBundle_whenBundlePathIsNil() {
        let s = CLIInstaller.state(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: nil
        )
        XCTAssertEqual(s, .notInBundle)
    }

    func testState_notInstalled_whenSymlinkAbsent() {
        let s = CLIInstaller.state(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: fakeBundleCLI.path
        )
        XCTAssertEqual(s, .notInstalled)
    }

    func testState_installedHere_whenSymlinkPointsAtBundleCLI() throws {
        // Stand up the canonical happy-state shape and assert state()
        // canonicalises through any intermediate symlinks on the temp path.
        try createSymlink(target: fakeBundleCLI.path, link: fakeSymlink.path)
        let s = CLIInstaller.state(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: fakeBundleCLI.path
        )
        XCTAssertEqual(s, .installedHere)
    }

    func testState_installedElsewhere_whenSymlinkPointsSomewhereElse() throws {
        let other = tmpRoot.appendingPathComponent("other.bin")
        try Data("ignored".utf8).write(to: other)
        try createSymlink(target: other.path, link: fakeSymlink.path)

        let s = CLIInstaller.state(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: fakeBundleCLI.path
        )
        if case .installedElsewhere(let target) = s {
            XCTAssertEqual(target, other.path)
        } else {
            XCTFail("expected .installedElsewhere, got \(s)")
        }
    }

    func testState_occupiedByOtherFile_whenRegularFileBlocksPath() throws {
        try Data("not a link".utf8).write(to: fakeSymlink)
        let s = CLIInstaller.state(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: fakeBundleCLI.path
        )
        XCTAssertEqual(s, .occupiedByOtherFile)
    }

    // MARK: - install() / uninstall()

    func testInstall_createsSymlink() throws {
        let result = CLIInstaller.install(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: fakeBundleCLI.path
        )
        XCTAssertEqual(result, .success)

        let target = try FileManager.default.destinationOfSymbolicLink(atPath: fakeSymlink.path)
        XCTAssertEqual(target, fakeBundleCLI.path)
    }

    func testInstall_idempotent_whenAlreadyInstalled() throws {
        _ = CLIInstaller.install(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: fakeBundleCLI.path
        )
        let second = CLIInstaller.install(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: fakeBundleCLI.path
        )
        XCTAssertEqual(second, .success)
    }

    func testInstall_overwritesExistingForeignSymlink() throws {
        let other = tmpRoot.appendingPathComponent("other.bin")
        try Data("ignored".utf8).write(to: other)
        try createSymlink(target: other.path, link: fakeSymlink.path)

        let result = CLIInstaller.install(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: fakeBundleCLI.path
        )
        XCTAssertEqual(result, .success)
        let target = try FileManager.default.destinationOfSymbolicLink(atPath: fakeSymlink.path)
        XCTAssertEqual(target, fakeBundleCLI.path)
    }

    func testInstall_overwritesRegularFile() throws {
        // The "occupiedByOtherFile" state lets the UI confirm with the
        // user; once they click Replace, install() should clear and
        // create just like the symlink case.
        try Data("not a link".utf8).write(to: fakeSymlink)

        let result = CLIInstaller.install(
            symlinkPath: fakeSymlink.path,
            bundledCLIPath: fakeBundleCLI.path
        )
        XCTAssertEqual(result, .success)
        let target = try FileManager.default.destinationOfSymbolicLink(atPath: fakeSymlink.path)
        XCTAssertEqual(target, fakeBundleCLI.path)
    }

    func testUninstall_removesSymlink() throws {
        try createSymlink(target: fakeBundleCLI.path, link: fakeSymlink.path)
        let result = CLIInstaller.uninstall(symlinkPath: fakeSymlink.path)
        XCTAssertEqual(result, .success)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fakeSymlink.path))
    }

    func testUninstall_idempotent_whenAbsent() {
        let result = CLIInstaller.uninstall(symlinkPath: fakeSymlink.path)
        XCTAssertEqual(result, .success)
    }

    // MARK: - resolveSymlinkPath()

    func testResolve_prefersHomebrewWhenWritable() throws {
        let hb = tmpRoot.appendingPathComponent("hb-bin")
        let ul = tmpRoot.appendingPathComponent("usr-local-bin")
        try FileManager.default.createDirectory(at: hb, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ul, withIntermediateDirectories: true)

        let path = CLIInstaller.resolveSymlinkPath(
            homebrewBin: hb.path,
            usrLocalBin: ul.path
        )
        XCTAssertEqual(path, hb.path + "/matisa")
    }

    func testResolve_fallsBackToUsrLocal_whenHomebrewMissing() throws {
        let hb = tmpRoot.appendingPathComponent("does-not-exist")
        let ul = tmpRoot.appendingPathComponent("usr-local-bin")
        try FileManager.default.createDirectory(at: ul, withIntermediateDirectories: true)

        let path = CLIInstaller.resolveSymlinkPath(
            homebrewBin: hb.path,
            usrLocalBin: ul.path
        )
        XCTAssertEqual(path, ul.path + "/matisa")
    }

    func testResolve_fallsBackToUsrLocal_whenHomebrewNotWritable() throws {
        let hb = tmpRoot.appendingPathComponent("hb-readonly")
        let ul = tmpRoot.appendingPathComponent("usr-local-bin")
        try FileManager.default.createDirectory(at: hb, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ul, withIntermediateDirectories: true)
        // Strip write permission so `access(W_OK)` rejects it — the same
        // condition real `/opt/homebrew/bin` would meet on a Mac without
        // Homebrew installed by the current user.
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o555], ofItemAtPath: hb.path
        )

        let path = CLIInstaller.resolveSymlinkPath(
            homebrewBin: hb.path,
            usrLocalBin: ul.path
        )
        XCTAssertEqual(path, ul.path + "/matisa")
    }

    func testResolve_lastResortIsUsrLocal_whenNeitherWritable() throws {
        let hb = tmpRoot.appendingPathComponent("hb-readonly")
        let ul = tmpRoot.appendingPathComponent("ul-readonly")
        try FileManager.default.createDirectory(at: hb, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ul, withIntermediateDirectories: true)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o555], ofItemAtPath: hb.path
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o555], ofItemAtPath: ul.path
        )

        let path = CLIInstaller.resolveSymlinkPath(
            homebrewBin: hb.path,
            usrLocalBin: ul.path
        )
        // The fallback is the historical default — that's what the sudo
        // command sheet will reference, and what users expect to escalate
        // into.
        XCTAssertEqual(path, ul.path + "/matisa")
    }

    // MARK: - sudoCommand()

    func testSudoCommand_quotesBundlePath() {
        let cmd = CLIInstaller.sudoCommand(bundled: "/Applications/Some App.app/Contents/Resources/bin/matisa")
        // The bundle path may contain spaces; the install fallback
        // command must quote it. The destination doesn't need quoting
        // since it's a fixed string.
        XCTAssertTrue(cmd.contains("\"/Applications/Some App.app/Contents/Resources/bin/matisa\""))
        XCTAssertTrue(cmd.hasPrefix("sudo ln -sf "))
    }

    // MARK: - helpers

    private func createSymlink(target: String, link: String) throws {
        let rc = target.withCString { tPtr in
            link.withCString { lPtr in
                symlink(tPtr, lPtr)
            }
        }
        if rc != 0 {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }
}
