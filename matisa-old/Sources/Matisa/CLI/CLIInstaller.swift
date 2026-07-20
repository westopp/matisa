import Foundation
import Darwin

/// Manages the `/usr/local/bin/matisa` symlink that puts the bundled CLI
/// on the user's PATH. Used by the Engine detail view's "Install
/// command-line tool" affordance — Docker Desktop / VS Code follow the
/// same convention.
///
/// Permissions: on Homebrew-installed Macs `/usr/local/bin` is user-
/// owned and `symlink(2)` succeeds without prompting. On stock macOS
/// it's root-owned; we detect EACCES and surface a copy-pasteable
/// `sudo ln -sf` command instead of trying to prompt for credentials
/// (the Security-framework prompt route would need app sandboxing
/// changes we don't want in Phase 4).
enum CLIInstaller {

    /// Where the symlink lives. Recomputed each time so the answer
    /// follows the machine's current state — e.g. if the user installs
    /// Homebrew while Matisa is open, the next click picks up the new
    /// writable PATH directory.
    ///
    /// Resolution order:
    ///   1. `/opt/homebrew/bin/matisa` — Apple Silicon's Homebrew prefix,
    ///      user-writable on every Mac that has Homebrew installed.
    ///      Already on the default PATH ahead of `/usr/local/bin`.
    ///   2. `/usr/local/bin/matisa` — Intel's Homebrew prefix and the
    ///      historical convention. User-writable on Intel Homebrew
    ///      installs; root-owned on stock macOS (Apple Silicon without
    ///      Homebrew).
    ///   3. Falls back to `/usr/local/bin/matisa` so the sudo command
    ///      sheet has a meaningful target when neither dir is writable.
    static var symlinkPath: String {
        return resolveSymlinkPath()
    }

    /// Production resolver — checks the real `/opt/homebrew/bin` and
    /// `/usr/local/bin`. Tests reach for the path-injectable overload
    /// of `state()` / `install()` / `uninstall()` instead.
    static func resolveSymlinkPath() -> String {
        return resolveSymlinkPath(
            homebrewBin: "/opt/homebrew/bin",
            usrLocalBin: "/usr/local/bin"
        )
    }

    /// Pure resolver — separated so tests can stand it up against tmp
    /// directories. `access(W_OK)` is what `cp` / `ln` use internally,
    /// so what it reports is what `symlink(2)` will succeed at.
    static func resolveSymlinkPath(
        homebrewBin: String,
        usrLocalBin: String
    ) -> String {
        let writable: (String) -> Bool = { access($0, W_OK) == 0 }

        if writable(homebrewBin) {
            return homebrewBin + "/matisa"
        }
        if writable(usrLocalBin) {
            return usrLocalBin + "/matisa"
        }
        // Last resort: stable historical default. The sudo fallback
        // command sheet will explain to the user that they need to
        // escalate, with a copy-pasteable `ln -sf …`.
        return usrLocalBin + "/matisa"
    }

    /// Path to the CLI inside the running app bundle, if any. Returns
    /// nil for non-bundle invocations (`swift run`), in which case the
    /// install affordance should be hidden — there's no stable binary
    /// to symlink to.
    static var bundledCLIPath: String? {
        let candidate = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/bin/matisa")
        // Bundle has to be `.app`-shaped AND the CLI must actually exist
        // at the expected place. Both conditions are needed: `swift run`
        // produces a Bundle.main whose URL doesn't end in `.app` but
        // could still have a stale binary under it, and a `.app` whose
        // build script forgot the cp step has no CLI to symlink.
        guard Bundle.main.bundleURL.pathExtension == "app" else { return nil }
        guard FileManager.default.isExecutableFile(atPath: candidate.path) else {
            return nil
        }
        return candidate.path
    }

    enum State: Equatable {
        /// `bundledCLIPath` is nil — not running from inside a `.app`.
        case notInBundle
        /// No symlink, nothing else there.
        case notInstalled
        /// Symlink exists and resolves (after canonicalisation) to *this*
        /// bundle's CLI. The happy steady state.
        case installedHere
        /// Symlink exists but points somewhere else — usually a different
        /// `Matisa.app` install (the dev's local build vs the
        /// Applications copy). Carries the resolved target so the UI can
        /// show what's actually there before clobbering it.
        case installedElsewhere(target: String)
        /// Something other than a symlink occupies the install path — a
        /// regular file or directory. Treat as a foreign object; refuse
        /// to overwrite without explicit user action (button → Replace
        /// → confirm sheet).
        case occupiedByOtherFile
    }

    static func state() -> State {
        return state(symlinkPath: symlinkPath, bundledCLIPath: bundledCLIPath)
    }

    /// Path-injectable variant for tests. Production callers use the
    /// no-arg overload; tests pass tmpdir paths so we never touch
    /// `/usr/local/bin/matisa` from `swift test`.
    static func state(symlinkPath: String, bundledCLIPath: String?) -> State {
        guard let bundled = bundledCLIPath else { return .notInBundle }

        // `lstat` queries the link itself rather than following it. The
        // FileManager equivalent (`attributesOfItem`) follows symlinks,
        // which is the wrong behaviour: a dead-link would surface as
        // ENOENT and we'd say "not installed" when actually a stale
        // symlink is occupying the path.
        switch symlinkKind(at: symlinkPath) {
        case .absent:
            return .notInstalled
        case .other:
            return .occupiedByOtherFile
        case .symlink:
            break
        }

        guard let target = try? FileManager.default
                .destinationOfSymbolicLink(atPath: symlinkPath) else {
            return .notInstalled
        }
        let resolved = canonicalise(target)
        let bundledResolved = canonicalise(bundled)
        if resolved == bundledResolved {
            return .installedHere
        }
        return .installedElsewhere(target: target)
    }

    private enum FSKind { case absent, symlink, other }

    private static func symlinkKind(at path: String) -> FSKind {
        var st = stat()
        let rc = path.withCString { lstat($0, &st) }
        if rc != 0 { return .absent }
        if (st.st_mode & S_IFMT) == S_IFLNK { return .symlink }
        return .other
    }

    /// Best-effort: resolve `..` / symlinks in a path so two paths to the
    /// same underlying file compare equal. Falls back to the input on
    /// failure (`URL.resolvingSymlinksInPath` doesn't throw and gives a
    /// best-effort answer, which is what we want).
    private static func canonicalise(_ path: String) -> String {
        return URL(fileURLWithPath: path)
            .resolvingSymlinksInPath()
            .standardizedFileURL
            .path
    }

    enum ActionResult: Equatable {
        case success
        /// We hit EACCES / EPERM writing to `/usr/local/bin`. Carries the
        /// `sudo ln -sf …` command the user can paste into a terminal.
        case permissionDenied(command: String)
        /// Catch-all for anything else — `errno` rendered for the user
        /// since this is the part they'd attach to a bug report.
        case error(String)
    }

    /// Create / overwrite the symlink. Idempotent: calling install when
    /// already installed-here is a no-op success; calling it when
    /// installed-elsewhere overwrites (the UI should have confirmed
    /// before this point).
    static func install() -> ActionResult {
        return install(symlinkPath: symlinkPath, bundledCLIPath: bundledCLIPath)
    }

    static func install(symlinkPath: String, bundledCLIPath: String?) -> ActionResult {
        guard let bundled = bundledCLIPath else {
            return .error("CLI binary not found inside the app bundle")
        }

        // If something exists, unlink first. `symlink(2)` won't overwrite
        // an existing file — it returns EEXIST. Pre-clear, then make.
        // `unlink` fails with EACCES on the parent dir, which is what we
        // surface to the user; the rare ENOENT race after our state()
        // check is harmless (we're about to create).
        if symlinkKind(at: symlinkPath) != .absent {
            let rc = unlink(symlinkPath)
            if rc != 0 && errno != ENOENT {
                return mapErrno(errno, bundled: bundled)
            }
        }

        let rc = symlink(bundled, symlinkPath)
        if rc == 0 {
            return .success
        }
        return mapErrno(errno, bundled: bundled)
    }

    /// Remove the symlink. Returns `.success` when the symlink either
    /// didn't exist or was successfully removed (idempotent uninstall).
    static func uninstall() -> ActionResult {
        return uninstall(symlinkPath: symlinkPath)
    }

    static func uninstall(symlinkPath: String) -> ActionResult {
        let rc = unlink(symlinkPath)
        if rc == 0 || errno == ENOENT {
            return .success
        }
        return mapErrno(errno, bundled: bundledCLIPath ?? "<bundle>")
    }

    private static func mapErrno(_ code: Int32, bundled: String) -> ActionResult {
        switch code {
        case EACCES, EPERM, EROFS:
            return .permissionDenied(command: sudoCommand(bundled: bundled))
        default:
            return .error("\(String(cString: strerror(code))) (errno \(code))")
        }
    }

    /// The copy-paste-able command the UI shows when we can't write the
    /// symlink ourselves. `-f` because the user has just answered "yes,
    /// replace existing"; quoting the bundle path lets it survive spaces
    /// in `/Applications/Matisa.app`.
    static func sudoCommand(bundled: String) -> String {
        return "sudo ln -sf \"\(bundled)\" \(symlinkPath)"
    }
}
