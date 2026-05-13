import Foundation
import MatisaCore

/// App-side reader/writer for `state.json`. The on-disk shape lives in
/// `MatisaCore.PersistedSpawn` / `PersistedState` so the engine can read the
/// same file. Today the app still owns writes; once Phase 2c moves lifecycle
/// into the engine, the writers move with it and this file becomes read-only
/// (used only by the local-fallback path).
enum StatePersistence {
    static func load() -> PersistedState {
        let url = Paths.stateFile
        guard let data = try? Data(contentsOf: url) else { return PersistedState() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let state = try? decoder.decode(PersistedState.self, from: data) else {
            return PersistedState()
        }
        return state
    }

    static func save(_ state: PersistedState) {
        let url = Paths.stateFile
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(state) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func upsert(_ spawn: PersistedSpawn) {
        var state = load()
        state.spawns.removeAll { $0.serviceID == spawn.serviceID }
        state.spawns.append(spawn)
        save(state)
    }

    static func remove(serviceID: String) {
        var state = load()
        state.spawns.removeAll { $0.serviceID == serviceID }
        save(state)
    }
}
