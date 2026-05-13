import XCTest
@testable import MatisaCore

/// Tests for the pure `ServiceMerge.merge` function. These are the contract
/// for what the engine returns from `services.snapshot` (and what the app's
/// local fallback produces) — any drift here is user-visible state drift.
final class ServiceMergeTests: XCTestCase {

    // MARK: - Project services

    func testProject_liveSpawn_isRunning() {
        let spec = ServiceSpec.project(ProjectFields(
            name: "web", path: URL(fileURLWithPath: "/tmp/web"),
            port: 5173, url: nil, command: "npm run dev",
            build: nil, scripts: [], group: nil, env: nil
        ))
        let started = Date(timeIntervalSince1970: 1_700_000_000)
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(ports: []),
            spawns: [persisted(id: "project:web", pid: 4242, port: 5173, startedAt: started)],
            liveSpawnPIDs: [4242],
            appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed.count, 1)
        XCTAssertEqual(result.unmanaged.count, 0)
        XCTAssertEqual(result.deadSpawnIDs, [])
        XCTAssertEqual(result.managed[0].state, .running(pid: 4242, since: started))
    }

    func testProject_liveSpawn_onWrongPort_doesNotSurfaceAsUnmanaged() {
        // Single-process dev server (e.g. bun) picked port 5174 because 5173
        // was already taken — listening != f.port. The spawn pid is still
        // alive. Should be one managed entry, zero unmanaged.
        let spec = ServiceSpec.project(ProjectFields(
            name: "web", path: URL(fileURLWithPath: "/tmp/web"),
            port: 5173, url: nil, command: "bun run dev",
            build: nil, scripts: [], group: nil, env: nil
        ))
        let started = Date(timeIntervalSince1970: 1_700_000_000)
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(ports: [port(pid: 4242, command: "bun", p: 5174)]),
            spawns: [persisted(id: "project:web", pid: 4242, port: 5173, startedAt: started)],
            liveSpawnPIDs: [4242],
            appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed.count, 1)
        XCTAssertEqual(result.managed[0].state, .running(pid: 4242, since: started))
        XCTAssertEqual(result.unmanaged.count, 0,
                       "spawn pid must not also surface as unmanaged")
    }

    func testProject_liveSpawn_winsOverListeningPortMismatch() {
        // npm spawns vite as a child; PIDs don't match but spawn is alive.
        let spec = ServiceSpec.project(ProjectFields(
            name: "web", path: URL(fileURLWithPath: "/tmp/web"),
            port: 5173, url: nil, command: "npm run dev",
            build: nil, scripts: [], group: nil, env: nil
        ))
        let started = Date(timeIntervalSince1970: 1_700_000_000)
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(ports: [port(pid: 99999, command: "vite", p: 5173)]),
            spawns: [persisted(id: "project:web", pid: 4242, port: 5173, startedAt: started)],
            liveSpawnPIDs: [4242],
            appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed[0].state, .running(pid: 4242, since: started))
        // The listening pid is consumed by the managed match so it doesn't
        // re-surface as an unmanaged process.
        XCTAssertEqual(result.unmanaged.count, 0)
    }

    func testProject_deadSpawn_listeningPort_isUnmanaged_andMarksDead() {
        let spec = ServiceSpec.project(ProjectFields(
            name: "web", path: URL(fileURLWithPath: "/tmp/web"),
            port: 5173, url: nil, command: "npm run dev",
            build: nil, scripts: [], group: nil, env: nil
        ))
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(ports: [port(pid: 88, command: "vite", p: 5173)]),
            spawns: [persisted(id: "project:web", pid: 4242, port: 5173,
                               startedAt: Date(timeIntervalSince1970: 1))],
            liveSpawnPIDs: [],  // spawn pid is dead
            appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed[0].state, .unmanaged(pid: 88))
        XCTAssertEqual(result.deadSpawnIDs, ["project:web"])
    }

    func testProject_deadSpawn_noListening_isStopped_andMarksDead() {
        let spec = ServiceSpec.project(ProjectFields(
            name: "web", path: URL(fileURLWithPath: "/tmp/web"),
            port: 5173, url: nil, command: "npm run dev",
            build: nil, scripts: [], group: nil, env: nil
        ))
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(ports: []),
            spawns: [persisted(id: "project:web", pid: 4242, port: 5173,
                               startedAt: Date(timeIntervalSince1970: 1))],
            liveSpawnPIDs: [],
            appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed[0].state, .stopped)
        XCTAssertEqual(result.deadSpawnIDs, ["project:web"])
    }

    func testProject_listeningPort_noSpawnAtAll_isUnmanaged_notMarkedDead() {
        let spec = ServiceSpec.project(ProjectFields(
            name: "web", path: URL(fileURLWithPath: "/tmp/web"),
            port: 5173, url: nil, command: "npm run dev",
            build: nil, scripts: [], group: nil, env: nil
        ))
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(ports: [port(pid: 77, command: "vite", p: 5173)]),
            spawns: [],
            liveSpawnPIDs: [],
            appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed[0].state, .unmanaged(pid: 77))
        XCTAssertEqual(result.deadSpawnIDs, [])
    }

    func testProject_noListening_noSpawn_isStopped() {
        let spec = ServiceSpec.project(ProjectFields(
            name: "web", path: URL(fileURLWithPath: "/tmp/web"),
            port: 5173, url: nil, command: "npm run dev",
            build: nil, scripts: [], group: nil, env: nil
        ))
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(ports: []),
            spawns: [],
            liveSpawnPIDs: [],
            appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed[0].state, .stopped)
    }

    // MARK: - Docker services

    func testDocker_matchingContainer_isRunning() {
        let spec = ServiceSpec.docker(DockerFields(
            name: "redis", image: "redis:7", port: 6379, url: nil,
            scripts: [], group: nil
        ))
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(
                containers: [container(name: "matisa.redis", state: "running")],
                dockerDaemonRunning: true
            ),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed.count, 1)
        if case .running = result.managed[0].state { /* ok */ } else { XCTFail("expected running") }
        XCTAssertEqual(result.unmanaged.count, 0)
    }

    func testDocker_listeningPortButNoContainer_isUnmanaged() {
        let spec = ServiceSpec.docker(DockerFields(
            name: "redis", image: "redis:7", port: 6379, url: nil,
            scripts: [], group: nil
        ))
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(
                ports: [port(pid: 33, command: "redis-server", p: 6379)],
                dockerDaemonRunning: true
            ),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed[0].state, .unmanaged(pid: 33))
    }

    func testDocker_daemonDown_filtersContainers_isStopped() {
        let spec = ServiceSpec.docker(DockerFields(
            name: "redis", image: "redis:7", port: 6379, url: nil,
            scripts: [], group: nil
        ))
        // Container is present in the snapshot but daemon-running is false —
        // merge treats containers/composeStacks as empty.
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(
                containers: [container(name: "matisa.redis", state: "running")],
                dockerDaemonRunning: false
            ),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed[0].state, .stopped)
    }

    // MARK: - Compose services

    func testCompose_matchingStackByFilePath_isRunning() {
        let file = URL(fileURLWithPath: "/Users/test/infra/compose.yml")
        let spec = ServiceSpec.compose(ComposeFields(
            name: "obs", file: file,
            ports: [ComposePort(host: 16686, url: nil)],
            build: nil, scripts: [], group: nil
        ))
        // Stack's docker project name differs from our config name — match
        // is by ConfigFiles path.
        let stack = DockerComposeStack(
            name: "observability", status: "running(3)",
            configFiles: file.path
        )
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(composeStacks: [stack], dockerDaemonRunning: true),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        if case .running = result.managed[0].state { /* ok */ } else {
            XCTFail("expected running, got \(result.managed[0].state)")
        }
    }

    func testCompose_runningClaimsItsPorts_soTheyDontSurfaceAsUnmanaged() {
        let file = URL(fileURLWithPath: "/x/compose.yml")
        let spec = ServiceSpec.compose(ComposeFields(
            name: "obs", file: file,
            ports: [ComposePort(host: 16686, url: nil)],
            build: nil, scripts: [], group: nil
        ))
        let result = ServiceMerge.merge(
            config: config(services: [spec]),
            snapshot: snapshot(
                ports: [port(pid: 55, command: "node", p: 16686)],  // dev-y
                composeStacks: [DockerComposeStack(
                    name: "obs", status: "running(1)", configFiles: file.path
                )],
                dockerDaemonRunning: true
            ),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        // The listening pid on the compose port is consumed by the managed
        // match — should not show as unmanaged.
        XCTAssertEqual(result.unmanaged.count, 0)
    }

    // MARK: - Unmanaged synthesis

    func testUnmanaged_devyPort_unmatched_becomesUnmanagedProcess_withAppName() {
        let result = ServiceMerge.merge(
            config: config(services: []),
            snapshot: snapshot(ports: [port(pid: 4242, command: "node", p: 3001)]),
            spawns: [], liveSpawnPIDs: [],
            appNamesByPID: [4242: "my-app"]
        )
        XCTAssertEqual(result.unmanaged.count, 1)
        guard case let .unmanaged(uf) = result.unmanaged[0].spec,
              case let .process(pid, command, p, appName) = uf.kind else {
            return XCTFail("expected unmanaged process")
        }
        XCTAssertEqual(pid, 4242)
        XCTAssertEqual(command, "node")
        XCTAssertEqual(p, 3001)
        XCTAssertEqual(appName, "my-app")
    }

    func testUnmanaged_nonDevPortIgnored() {
        let result = ServiceMerge.merge(
            config: config(services: []),
            snapshot: snapshot(ports: [port(pid: 5, command: "mysqld", p: 3306)]),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.unmanaged.count, 0)
    }

    func testUnmanaged_pidUnderOneFiltered() {
        let result = ServiceMerge.merge(
            config: config(services: []),
            snapshot: snapshot(ports: [port(pid: 1, command: "node", p: 3000)]),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.unmanaged.count, 0)
    }

    func testUnmanaged_duplicatePIDDedupedAcrossPorts() {
        // One process listening on two ports — surfaces once.
        let result = ServiceMerge.merge(
            config: config(services: []),
            snapshot: snapshot(ports: [
                port(pid: 4242, command: "node", p: 3000),
                port(pid: 4242, command: "node", p: 3001),
            ]),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.unmanaged.count, 1)
    }

    func testUnmanagedContainer_notPrefixed_surfaces() {
        let result = ServiceMerge.merge(
            config: config(services: []),
            snapshot: snapshot(
                containers: [DockerContainer(
                    id: "x", name: "rogue", image: "alpine:3.19",
                    state: "running", status: "Up", ports: "0.0.0.0:8080->8080/tcp"
                )],
                dockerDaemonRunning: true
            ),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.unmanaged.count, 1)
        guard case let .unmanaged(uf) = result.unmanaged[0].spec,
              case let .container(name, image, port) = uf.kind else {
            return XCTFail("expected unmanaged container")
        }
        XCTAssertEqual(name, "rogue")
        XCTAssertEqual(image, "alpine:3.19")
        XCTAssertEqual(port, 8080)
    }

    func testUnmanagedContainer_matisaPrefixed_isFiltered() {
        let result = ServiceMerge.merge(
            config: config(services: []),
            snapshot: snapshot(
                containers: [container(name: "matisa.redis", state: "running")],
                dockerDaemonRunning: true
            ),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.unmanaged.count, 0)
    }

    func testUnmanagedContainer_belongingToKnownComposeStack_isFiltered() {
        let file = URL(fileURLWithPath: "/x/compose.yml")
        let composeSpec = ServiceSpec.compose(ComposeFields(
            name: "obs", file: file,
            ports: [ComposePort(host: 16686, url: nil)],
            build: nil, scripts: [], group: nil
        ))
        // docker resolves the compose project to "observability" via the file
        // path; child container is named "observability-collector-1".
        let result = ServiceMerge.merge(
            config: config(services: [composeSpec]),
            snapshot: snapshot(
                containers: [container(name: "observability-collector-1", state: "running")],
                composeStacks: [DockerComposeStack(
                    name: "observability", status: "running(1)", configFiles: file.path
                )],
                dockerDaemonRunning: true
            ),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.unmanaged.count, 0)
    }

    // MARK: - Sort order

    func testManagedSort_kindThenName() {
        let project = ServiceSpec.project(ProjectFields(
            name: "zeta", path: URL(fileURLWithPath: "/z"),
            port: 3000, url: nil, command: "x",
            build: nil, scripts: [], group: nil, env: nil
        ))
        let docker = ServiceSpec.docker(DockerFields(
            name: "alpha", image: "i", port: 4000, url: nil,
            scripts: [], group: nil
        ))
        let compose = ServiceSpec.compose(ComposeFields(
            name: "mid", file: URL(fileURLWithPath: "/c"),
            ports: [], build: nil, scripts: [], group: nil
        ))
        let result = ServiceMerge.merge(
            config: config(services: [docker, compose, project]),
            snapshot: snapshot(),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed.map(\.kind), [.project, .docker, .compose])
    }

    func testUnmanagedSort_byPortAscending() {
        let result = ServiceMerge.merge(
            config: config(services: []),
            snapshot: snapshot(ports: [
                port(pid: 11, command: "node", p: 5000),
                port(pid: 22, command: "node", p: 3000),
                port(pid: 33, command: "node", p: 4000),
            ]),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        let ports = result.unmanaged.compactMap { $0.spec.exposedPorts.first?.port }
        XCTAssertEqual(ports, [3000, 4000, 5000])
    }

    // MARK: - Empty inputs

    func testEmptyInputs_produceEmptyResult() {
        let result = ServiceMerge.merge(
            config: config(services: []),
            snapshot: snapshot(),
            spawns: [], liveSpawnPIDs: [], appNamesByPID: [:]
        )
        XCTAssertEqual(result.managed, [])
        XCTAssertEqual(result.unmanaged, [])
        XCTAssertEqual(result.deadSpawnIDs, [])
    }

    // MARK: - Fixtures

    private func config(services: [ServiceSpec]) -> AppConfig {
        AppConfig(
            caddyfile: nil,
            services: services,
            tunnel: .defaults,
            localNetwork: .defaults
        )
    }

    private func snapshot(
        ports: [ListeningPort] = [],
        containers: [DockerContainer] = [],
        composeStacks: [DockerComposeStack] = [],
        brewServices: [BrewService] = [],
        dockerDaemonRunning: Bool = false,
        takenAt: Date = Date(timeIntervalSince1970: 1_700_000_000)
    ) -> DiscoverySnapshot {
        DiscoverySnapshot(
            ports: ports,
            containers: containers,
            composeStacks: composeStacks,
            brewServices: brewServices,
            dockerDaemonRunning: dockerDaemonRunning,
            takenAt: takenAt
        )
    }

    private func port(pid: Int32, command: String, p: Int) -> ListeningPort {
        ListeningPort(pid: pid, command: command, address: "*:\(p)", port: p)
    }

    private func container(name: String, state: String) -> DockerContainer {
        DockerContainer(
            id: "id-\(name)", name: name, image: "img",
            state: state, status: state == "running" ? "Up 1 minute" : "Exited",
            ports: ""
        )
    }

    private func persisted(id: String, pid: Int32, port: Int?, startedAt: Date) -> PersistedSpawn {
        PersistedSpawn(serviceID: id, pid: pid, port: port,
                       startedAt: startedAt, logPath: "/tmp/\(id).log")
    }
}
