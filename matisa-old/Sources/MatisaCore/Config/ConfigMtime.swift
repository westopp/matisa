import Foundation

/// Computes the most recent modification time across all `.ts` files inside
/// a config directory, used by both the engine's `ConfigService` and the
/// app's `ConfigLoader` to invalidate their mtime caches.
///
/// Why walk a directory instead of stat'ing `services.ts` alone: users can
/// split per-project entries out under `projects/**/*.ts` and import them
/// from `services.ts`. Editing one of those files leaves `services.ts`'s
/// mtime untouched, so a single-file check would silently miss the change.
/// Walking every `.ts` under the config dir catches the edit and triggers
/// a re-eval at the next call site.
///
/// The walk is cheap (the config dir is small — a handful of files), and
/// hidden directories are skipped so `.git` / `.DS_Store` don't interfere
/// when the dotfiles are versioned.
public enum ConfigMtime {

    /// Returns the latest `.ts` mtime under `directory`, recursively.
    /// Returns `.distantPast` if the directory cannot be enumerated or
    /// contains no `.ts` files — the caller compares against a cached
    /// value, so any constant sentinel works as long as it's stable.
    public static func latest(under directory: URL) -> Date {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return .distantPast
        }

        var maxDate: Date = .distantPast
        for case let url as URL in enumerator {
            guard url.pathExtension == "ts" else { continue }
            let values = try? url.resourceValues(
                forKeys: [.isRegularFileKey, .contentModificationDateKey]
            )
            guard values?.isRegularFile == true,
                  let mtime = values?.contentModificationDate
            else { continue }
            if mtime > maxDate { maxDate = mtime }
        }
        return maxDate
    }
}
