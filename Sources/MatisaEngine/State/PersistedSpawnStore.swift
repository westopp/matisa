import Foundation
import MatisaCore

/// Engine-side reader/writer for `CorePaths.stateFile`. Same JSON shape and
/// date strategy as the app's `StatePersistence` so both targets round-trip
/// through one file.
///
/// Writes are serialized through an internal dispatch queue and committed via
/// a tmp + `rename(2)` so a crashed engine never leaves a half-written file
/// on disk. The app still owns writes today; Phase 2c.2 switches ownership
/// to the engine and demotes the app's writer to fallback-only.
final class PersistedSpawnStore {

    private let stateFile: URL
    private let queue = DispatchQueue(label: "engine.persisted-spawn")

    init(stateFile: URL = CorePaths.stateFile) {
        self.stateFile = stateFile
    }

    /// Load the persisted state from disk. Returns an empty `PersistedState`
    /// when the file is missing or fails to decode — same behaviour as the
    /// app's `StatePersistence.load`.
    func load() -> PersistedState {
        queue.sync { loadLocked() }
    }

    func spawns() -> [PersistedSpawn] { load().spawns }

    /// Insert or replace by `serviceID`. If a spawn with the same `serviceID`
    /// already exists it's overwritten; otherwise the new spawn is appended.
    func upsert(_ spawn: PersistedSpawn) {
        queue.sync {
            var state = loadLocked()
            state.spawns.removeAll { $0.serviceID == spawn.serviceID }
            state.spawns.append(spawn)
            saveLocked(state)
        }
    }

    /// Remove the spawn record for `serviceID`. Non-existent IDs are a no-op.
    func remove(serviceID: String) {
        queue.sync {
            var state = loadLocked()
            state.spawns.removeAll { $0.serviceID == serviceID }
            saveLocked(state)
        }
    }

    // MARK: - Locked helpers (must be called from `queue`)

    private func loadLocked() -> PersistedState {
        guard let data = try? Data(contentsOf: stateFile) else { return PersistedState() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(PersistedState.self, from: data)) ?? PersistedState()
    }

    private func saveLocked(_ state: PersistedState) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(state) else { return }

        // Make sure the parent dir exists — first-write on a fresh install
        // hits a missing `~/Library/Application Support/Matisa/` otherwise.
        let parent = stateFile.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: parent,
            withIntermediateDirectories: true
        )

        // Atomic replace: write to <stateFile>.tmp then rename. `rename(2)`
        // is atomic within a filesystem, so readers either see the old file
        // or the new one — never a partial write.
        let tmpURL = URL(fileURLWithPath: stateFile.path + ".tmp")
        do {
            try data.write(to: tmpURL, options: .atomic)
        } catch {
            return
        }
        let renameRC = Darwin.rename(tmpURL.path, stateFile.path)
        if renameRC != 0 {
            // Best-effort cleanup so we don't leave a `.tmp` lying around.
            try? FileManager.default.removeItem(at: tmpURL)
        }
    }
}
