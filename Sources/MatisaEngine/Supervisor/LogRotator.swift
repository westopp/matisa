import Foundation
import MatisaCore

/// Engine-side port of the app's `LogRotator`. Rotates per-service log files
/// when they grow past 4MB or are older than 2 days. Keeps a single previous
/// file as `<id>.log.1`. Idempotent and cheap — safe to call from the engine's
/// refresh loop.
///
/// MARK: - Not tested directly
/// File-size / file-age based — deterministic testing requires contrived
/// setup (mocking dates, writing large fixture files) that pays back very
/// little. The app's matching `LogRotator` has the same coverage policy.
enum LogRotator {
    static let maxBytes: Int64 = 4 * 1024 * 1024
    static let maxAge: TimeInterval = 2 * 24 * 60 * 60

    /// Rotate every `*.log` file in `CorePaths.logsDir` that's over the limits.
    static func rotateAll() {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: CorePaths.logsDir,
            includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        for url in entries where url.pathExtension == "log" {
            rotateIfNeeded(url)
        }
    }

    static func rotateIfNeeded(_ url: URL) {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { return }
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = attrs[.modificationDate] as? Date ?? Date()

        let tooBig = size >= maxBytes
        let tooOld = Date().timeIntervalSince(mtime) >= maxAge
        guard tooBig || tooOld else { return }

        let backup = url.deletingPathExtension().appendingPathExtension("log.1")
        try? fm.removeItem(at: backup)
        try? fm.moveItem(at: url, to: backup)
        // Recreate empty so the running process's open fd remains useful only
        // until next rotation; the spawned process opened with O_APPEND so it
        // will continue writing — but since we moved the file, the fd points
        // to the rotated file (.log.1) and will keep appending there. New
        // spawns will reopen .log fresh. This is acceptable for local dev.
        fm.createFile(atPath: url.path, contents: nil)
    }
}
