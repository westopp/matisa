import XCTest
import MatisaCore
@testable import Matisa

final class ConfigTests: XCTestCase {
    func testProjectDecoding() throws {
        let json = """
        {
          "caddyfile": "~/dev/Caddyfile",
          "services": [
            {"type":"project","name":"review-view","path":"~/dev/review-view","port":5478,"url":"review-view.localhost","command":"npm run dev"}
          ]
        }
        """
        let raw = try JSONDecoder().decode(RawConfig.self, from: Data(json.utf8))
        let cfg = try AppConfig.from(raw)

        XCTAssertEqual(cfg.services.count, 1)
        guard case let .project(f) = cfg.services[0] else {
            return XCTFail("expected project")
        }
        XCTAssertEqual(f.name, "review-view")
        XCTAssertEqual(f.port, 5478)
        XCTAssertEqual(f.url, "review-view.localhost")
        XCTAssertEqual(f.command, "npm run dev")
        XCTAssertTrue(f.path.path.hasSuffix("/dev/review-view"))
        XCTAssertNotNil(cfg.caddyfile)
        XCTAssertTrue(cfg.caddyfile!.path.hasSuffix("/dev/Caddyfile"))
    }

    func testDockerDecoding() throws {
        let json = """
        {"services":[{"type":"docker","name":"redis","image":"redis:7","port":6379,"url":"redis.localhost"}]}
        """
        let raw = try JSONDecoder().decode(RawConfig.self, from: Data(json.utf8))
        let cfg = try AppConfig.from(raw)
        guard case let .docker(f) = cfg.services[0] else {
            return XCTFail("expected docker")
        }
        XCTAssertEqual(f.image, "redis:7")
        XCTAssertEqual(f.port, 6379)
    }

    func testComposeDecoding() throws {
        let json = """
        {"services":[{"type":"compose","name":"obs","file":"~/dev/infra/otel/docker-compose.yml","ports":[{"host":16686,"url":"jaeger.localhost"},{"host":4317}]}]}
        """
        let raw = try JSONDecoder().decode(RawConfig.self, from: Data(json.utf8))
        let cfg = try AppConfig.from(raw)
        guard case let .compose(f) = cfg.services[0] else {
            return XCTFail("expected compose")
        }
        XCTAssertEqual(f.ports.count, 2)
        XCTAssertEqual(f.ports[0].host, 16686)
        XCTAssertEqual(f.ports[0].url, "jaeger.localhost")
        XCTAssertNil(f.ports[1].url)
    }

    func testProjectMissingFieldThrows() {
        let json = """
        {"services":[{"type":"project","name":"foo","port":5400}]}
        """
        XCTAssertThrowsError(try {
            let raw = try JSONDecoder().decode(RawConfig.self, from: Data(json.utf8))
            _ = try AppConfig.from(raw)
        }())
    }

    func testUnknownTypeThrows() {
        let json = """
        {"services":[{"type":"mysql","name":"db"}]}
        """
        XCTAssertThrowsError(try {
            let raw = try JSONDecoder().decode(RawConfig.self, from: Data(json.utf8))
            _ = try AppConfig.from(raw)
        }())
    }

    func testCaddyfileGeneration() throws {
        let cfg = AppConfig(
            caddyfile: URL(fileURLWithPath: "/tmp/Caddyfile-test"),
            services: [
                .project(ProjectFields(
                    name: "rv", path: URL(fileURLWithPath: "/tmp/rv"),
                    port: 5478, url: "rv.localhost", command: "npm run dev",
                    commands: [], group: nil, env: nil
                )),
                .docker(DockerFields(
                    name: "redis", image: "redis:7", port: 6379, url: nil,
                    commands: [], group: nil
                )),
                .compose(ComposeFields(
                    name: "obs",
                    file: URL(fileURLWithPath: "/tmp/dc.yml"),
                    ports: [
                        ComposePort(host: 16686, url: "jaeger.localhost"),
                        ComposePort(host: 4317, url: nil),
                    ],
                    commands: [], group: nil
                ))
            ],
            tunnel: .defaults,
            localNetwork: .defaults
        )
        let rendered = CaddyfileGenerator.render(from: cfg)
        XCTAssertTrue(rendered.contains("auto_https off"))
        XCTAssertTrue(rendered.contains("http://rv.localhost"))
        XCTAssertTrue(rendered.contains("reverse_proxy localhost:5478"))
        XCTAssertTrue(rendered.contains("http://jaeger.localhost"))
        XCTAssertTrue(rendered.contains("reverse_proxy localhost:16686"))
        XCTAssertFalse(rendered.contains("redis"), "redis has no url; should not be in Caddyfile")
        XCTAssertFalse(rendered.contains(":4317"), "no-url compose port should not appear")
    }
}
