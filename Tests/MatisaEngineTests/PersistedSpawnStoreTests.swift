import XCTest
import MatisaCore
@testable import MatisaEngine

/// Pins the on-disk format `PersistedSpawnStore` accepts. The app's
/// `StatePersistence.save` writes this exact shape (iso8601 dates, pretty
/// keys); a silent drift on either side breaks managed-service tracking
/// across engine/app boundaries. The fixture string below is the ground
/// truth for the file format — keep it in sync if you intentionally change
/// the persisted shape.
final class PersistedSpawnStoreTests: XCTestCase {

    private func tempStateFile() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("matisa-state-\(UUID().uuidString).json")
    }

    /// JSON the app's `StatePersistence.save` would emit for the same
    /// `PersistedState`. Hardcoded so the test fails if either side drifts
    /// from the iso8601 / pretty-printed / sorted-keys contract.
    private let fixtureJSON = """
    {
      "spawns" : [
        {
          "logPath" : "/Users/u/Library/Logs/Matisa/project-web.log",
          "pid" : 4242,
          "port" : 5173,
          "serviceID" : "project:web",
          "startedAt" : "2023-11-14T22:13:20Z"
        },
        {
          "logPath" : "/Users/u/Library/Logs/Matisa/project-api.log",
          "pid" : 1234,
          "serviceID" : "project:api",
          "startedAt" : "2023-11-14T22:14:00Z"
        }
      ],
      "version" : 1
    }
    """

    func testLoad_decodesFixtureFormat() throws {
        let url = tempStateFile()
        try fixtureJSON.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        let store = PersistedSpawnStore(stateFile: url)
        let state = store.load()
        XCTAssertEqual(state.version, 1)
        XCTAssertEqual(state.spawns.count, 2)

        let web = state.spawns.first(where: { $0.serviceID == "project:web" })
        XCTAssertEqual(web?.pid, 4242)
        XCTAssertEqual(web?.port, 5173)
        XCTAssertEqual(web?.logPath, "/Users/u/Library/Logs/Matisa/project-web.log")
        XCTAssertEqual(web?.startedAt, Date(timeIntervalSince1970: 1_700_000_000))

        let api = state.spawns.first(where: { $0.serviceID == "project:api" })
        XCTAssertEqual(api?.pid, 1234)
        XCTAssertNil(api?.port)
    }

    func testSpawns_isShorthand() throws {
        let url = tempStateFile()
        try fixtureJSON.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        let store = PersistedSpawnStore(stateFile: url)
        XCTAssertEqual(store.spawns().count, 2)
    }

    func testLoad_missingFile_returnsEmptyState() {
        let store = PersistedSpawnStore(stateFile: tempStateFile())
        let state = store.load()
        XCTAssertEqual(state.version, 1)
        XCTAssertEqual(state.spawns, [])
    }

    func testLoad_malformedJSON_returnsEmptyState() throws {
        let url = tempStateFile()
        try "not json at all".write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        let store = PersistedSpawnStore(stateFile: url)
        let state = store.load()
        XCTAssertEqual(state.spawns, [])
    }

    func testLoad_wrongDateStrategy_isDetected() throws {
        // Sanity check: a file written with the default (numeric) date
        // strategy must not silently round-trip through PersistedSpawnStore,
        // which expects iso8601. If this test ever passes, someone changed
        // PersistedSpawnStore's date strategy and the file-format contract
        // with StatePersistence is broken.
        let badEncoder = JSONEncoder()
        // No dateEncodingStrategy set — defaults to .deferredToDate (numeric).
        let bad = PersistedState(version: 1, spawns: [PersistedSpawn(
            serviceID: "project:web", pid: 1, port: 1,
            startedAt: Date(timeIntervalSince1970: 1_700_000_000),
            logPath: "/x"
        )])
        let data = try badEncoder.encode(bad)
        let url = tempStateFile()
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let store = PersistedSpawnStore(stateFile: url)
        let state = store.load()
        XCTAssertEqual(state.spawns, [], "non-iso8601 dates must fail to decode")
    }
}
