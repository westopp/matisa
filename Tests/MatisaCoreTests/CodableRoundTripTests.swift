import XCTest
@testable import MatisaCore

/// Round-trip tests for every Codable conformance with manual encode/decode.
/// Auto-derived conformances get smoke coverage via `ServiceSpec`, which
/// nests them. These types ride the JSON-RPC wire from phase 2b onward —
/// a tag mismatch or missing field would silently corrupt every client.
final class CodableRoundTripTests: XCTestCase {

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private func roundTrip<T: Codable & Equatable>(
        _ value: T,
        file: StaticString = #file,
        line: UInt = #line
    ) throws {
        let data = try encoder.encode(value)
        let decoded = try decoder.decode(T.self, from: data)
        XCTAssertEqual(value, decoded, file: file, line: line)
    }

    // MARK: - BuildSpec (string or array)

    func testBuildSpec_single_roundTrips() throws {
        try roundTrip(BuildSpec.single("npm run build"))
    }

    func testBuildSpec_multi_roundTrips() throws {
        try roundTrip(BuildSpec.multi([
            NamedCommand(name: "web", command: "npm run build:web"),
            NamedCommand(name: "api", command: "npm run build:api"),
        ]))
    }

    func testBuildSpec_single_wireShapeIsBareString() throws {
        let data = try encoder.encode(BuildSpec.single("make"))
        let json = String(data: data, encoding: .utf8)
        XCTAssertEqual(json, "\"make\"")
    }

    func testBuildSpec_multi_wireShapeIsArray() throws {
        let data = try encoder.encode(BuildSpec.multi([
            NamedCommand(name: "a", command: "cmd-a"),
        ]))
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]]
        XCTAssertEqual(json?.count, 1)
        XCTAssertEqual(json?.first?["name"], "a")
        XCTAssertEqual(json?.first?["command"], "cmd-a")
    }

    // MARK: - UnmanagedKind

    func testUnmanagedKind_process_full() throws {
        try roundTrip(UnmanagedKind.process(
            pid: 12345, command: "node dev.js", port: 3000, appName: "Cursor"
        ))
    }

    func testUnmanagedKind_process_appNameNil() throws {
        try roundTrip(UnmanagedKind.process(
            pid: 99, command: "ruby app.rb", port: 4567, appName: nil
        ))
    }

    func testUnmanagedKind_container_withPort() throws {
        try roundTrip(UnmanagedKind.container(
            name: "redis-runner", image: "redis:7", port: 6379
        ))
    }

    func testUnmanagedKind_container_portNil() throws {
        try roundTrip(UnmanagedKind.container(
            name: "scratchpad", image: "alpine:3.19", port: nil
        ))
    }

    // MARK: - ServiceState

    func testServiceState_stopped() throws {
        try roundTrip(ServiceState.stopped)
    }

    func testServiceState_starting() throws {
        try roundTrip(ServiceState.starting)
    }

    func testServiceState_running() throws {
        // Use seconds-precision Date so JSON round-trip doesn't lose
        // sub-second precision that the default encoder strips.
        let since = Date(timeIntervalSince1970: 1_700_000_000)
        try roundTrip(ServiceState.running(pid: 4242, since: since))
    }

    func testServiceState_stopping() throws {
        try roundTrip(ServiceState.stopping)
    }

    func testServiceState_unmanaged() throws {
        try roundTrip(ServiceState.unmanaged(pid: 7777))
    }

    func testServiceState_error() throws {
        try roundTrip(ServiceState.error("port 5478 already in use"))
    }

    // MARK: - DockerSystemState

    func testDockerSystemState_allVariants() throws {
        try roundTrip(DockerSystemState.unknown)
        try roundTrip(DockerSystemState.running)
        try roundTrip(DockerSystemState.stopped)
        try roundTrip(DockerSystemState.starting)
        try roundTrip(DockerSystemState.startFailed("Docker didn't come up in time"))
    }

    // MARK: - PublicTunnelStatus

    func testPublicTunnelStatus_allVariants() throws {
        try roundTrip(PublicTunnelStatus.idle)
        try roundTrip(PublicTunnelStatus.connecting)
        try roundTrip(PublicTunnelStatus.live(url: "https://abc.tunnel.westopp.com"))
        try roundTrip(PublicTunnelStatus.disconnected)
        try roundTrip(PublicTunnelStatus.error("sish refused connection"))
    }

    // MARK: - SameNetworkStatus

    func testSameNetworkStatus_allVariants() throws {
        try roundTrip(SameNetworkStatus.idle)
        try roundTrip(SameNetworkStatus.advertising(hostname: "web.matisa.local"))
        try roundTrip(SameNetworkStatus.active(hostname: "web.matisa.local"))
        try roundTrip(SameNetworkStatus.error("no LAN interface"))
    }

    // MARK: - ServiceExposure (composite — exercises both inner enums)

    func testServiceExposure_composite() throws {
        try roundTrip(ServiceExposure(
            publicTunnel: .live(url: "https://x.tunnel.example.com"),
            sameNetwork: .active(hostname: "x.matisa.local")
        ))
        try roundTrip(ServiceExposure(publicTunnel: .idle, sameNetwork: .idle))
    }

    // MARK: - ServiceSpec (each variant; nests every auto-derived struct)

    func testServiceSpec_project_full() throws {
        let spec = ServiceSpec.project(ProjectFields(
            name: "web",
            path: URL(fileURLWithPath: "/Users/test/code/web"),
            port: 5173,
            url: "web.localhost",
            command: "npm run dev",
            build: .multi([NamedCommand(name: "default", command: "npm run build")]),
            scripts: [NamedCommand(name: "lint", command: "npm run lint")],
            group: "frontend",
            env: EnvSpec(
                base: [EnvVar(name: "PORT", value: "5173")],
                contexts: [EnvContext(name: "dev", vars: [
                    EnvVar(name: "API_URL", value: "http://localhost:8080"),
                ])]
            )
        ))
        try roundTrip(spec)
    }

    func testServiceSpec_project_minimal() throws {
        // All optionals nil, no build, no scripts, no env.
        let spec = ServiceSpec.project(ProjectFields(
            name: "minimal", path: URL(fileURLWithPath: "/tmp/m"),
            port: 3000, url: nil, command: "run",
            build: nil, scripts: [], group: nil, env: nil
        ))
        try roundTrip(spec)
    }

    func testServiceSpec_docker() throws {
        try roundTrip(ServiceSpec.docker(DockerFields(
            name: "redis", image: "redis:7", port: 6379, url: nil,
            scripts: [], group: "infra"
        )))
    }

    func testServiceSpec_compose() throws {
        try roundTrip(ServiceSpec.compose(ComposeFields(
            name: "obs",
            file: URL(fileURLWithPath: "/Users/test/infra/compose.yml"),
            ports: [
                ComposePort(host: 16686, url: "jaeger.localhost"),
                ComposePort(host: 4317, url: nil),
            ],
            build: .single("docker compose build"),
            scripts: [NamedCommand(name: "logs", command: "docker compose logs -f")],
            group: nil
        )))
    }

    func testServiceSpec_unmanaged_process() throws {
        try roundTrip(ServiceSpec.unmanaged(UnmanagedFields(
            kind: .process(pid: 1234, command: "node", port: 3001, appName: nil)
        )))
    }

    func testServiceSpec_unmanaged_container() throws {
        try roundTrip(ServiceSpec.unmanaged(UnmanagedFields(
            kind: .container(name: "rogue", image: "postgres:16", port: 5432)
        )))
    }

    // MARK: - ServiceSpec wire shape sanity

    func testServiceSpec_project_wireShapeUsesTypeFieldsEnvelope() throws {
        let spec = ServiceSpec.docker(DockerFields(
            name: "x", image: "y", port: 1, url: nil,
            scripts: [], group: nil
        ))
        let data = try encoder.encode(spec)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(json?["type"] as? String, "docker")
        XCTAssertNotNil(json?["fields"] as? [String: Any])
    }

    // MARK: - ServiceKind (string enum)

    func testServiceKind_allVariants() throws {
        try roundTrip(ServiceKind.project)
        try roundTrip(ServiceKind.docker)
        try roundTrip(ServiceKind.compose)
        try roundTrip(ServiceKind.unmanaged)
    }
}
