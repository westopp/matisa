import Foundation
import MatisaCore

/// Engine-side reader for `CorePaths.stateFile`. Same JSON shape and date
/// strategy as the app's `StatePersistence` so both targets round-trip
/// through one file.
///
/// **Read-only for Phase 2b.2.** The app still owns writes (start/stop, etc).
/// Once Phase 2c moves lifecycle into the engine the writers move here and
/// the app's `StatePersistence` becomes fallback-only.
final class PersistedSpawnStore {

    private let stateFile: URL

    init(stateFile: URL = CorePaths.stateFile) {
        self.stateFile = stateFile
    }

    func load() -> PersistedState {
        guard let data = try? Data(contentsOf: stateFile) else { return PersistedState() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(PersistedState.self, from: data)) ?? PersistedState()
    }

    func spawns() -> [PersistedSpawn] { load().spawns }
}
