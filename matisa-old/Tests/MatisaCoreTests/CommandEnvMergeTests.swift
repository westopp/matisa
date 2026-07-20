import XCTest
@testable import MatisaCore

/// Tests for command-level env overrides. Mirrors the merge ServiceStore
/// performs at spawn time: service env first, command env layered on top,
/// command wins on conflict. The test exercises `EnvSpec.effective` for
/// both layers and the dictionary merge that combines them — drift here
/// would silently leak the wrong env into a spawned command.
final class CommandEnvMergeTests: XCTestCase {

    private func merge(
        service: EnvSpec?,
        command: EnvSpec?,
        activeContext: String?
    ) -> [String: String] {
        var env = service?.effective(activeContext: activeContext) ?? [:]
        if let command {
            env.merge(command.effective(activeContext: activeContext)) { _, cmd in cmd }
        }
        return env
    }

    // MARK: - Base layer (no active context)

    func testCommandBase_overridesServiceBase_keepsCommandOnlyAndServiceOnlyKeys() {
        let service = EnvSpec(
            base: [
                EnvVar(name: "A", value: "service"),
                EnvVar(name: "C", value: "svc-only"),
            ],
            contexts: []
        )
        let command = EnvSpec(
            base: [
                EnvVar(name: "A", value: "command"),
                EnvVar(name: "B", value: "cmd-only"),
            ],
            contexts: []
        )
        let merged = merge(service: service, command: command, activeContext: nil)
        XCTAssertEqual(merged, [
            "A": "command",
            "B": "cmd-only",
            "C": "svc-only",
        ])
    }

    // MARK: - Active context layer

    func testCommandContext_overridesServiceContext_whenActive() {
        let service = EnvSpec(
            base: [EnvVar(name: "A", value: "svc-base")],
            contexts: [EnvContext(name: "prod", vars: [
                EnvVar(name: "A", value: "svc-ctx"),
            ])]
        )
        let command = EnvSpec(
            base: [],
            contexts: [EnvContext(name: "prod", vars: [
                EnvVar(name: "A", value: "cmd-ctx"),
            ])]
        )
        let merged = merge(service: service, command: command, activeContext: "prod")
        XCTAssertEqual(merged["A"], "cmd-ctx")
    }

    func testCommandContext_notApplied_whenDifferentContextActive() {
        // Command declares a `prod` context; active context is `staging`.
        // Service has nothing for `staging`, so only base wins.
        let service = EnvSpec(
            base: [EnvVar(name: "A", value: "svc-base")],
            contexts: []
        )
        let command = EnvSpec(
            base: [],
            contexts: [EnvContext(name: "prod", vars: [
                EnvVar(name: "A", value: "cmd-ctx"),
            ])]
        )
        let merged = merge(service: service, command: command, activeContext: "staging")
        XCTAssertEqual(merged, ["A": "svc-base"])
    }

    // MARK: - Order-of-layering

    func testCommandBaseAndContext_layeredOnTopOfService() {
        // Full stack: service base → service context → command base → command context.
        let service = EnvSpec(
            base: [
                EnvVar(name: "A", value: "svc-base"),
                EnvVar(name: "B", value: "svc-base"),
                EnvVar(name: "C", value: "svc-base"),
            ],
            contexts: [EnvContext(name: "prod", vars: [
                EnvVar(name: "B", value: "svc-ctx"),
                EnvVar(name: "C", value: "svc-ctx"),
            ])]
        )
        let command = EnvSpec(
            base: [EnvVar(name: "C", value: "cmd-base")],
            contexts: [EnvContext(name: "prod", vars: [
                EnvVar(name: "C", value: "cmd-ctx"),
            ])]
        )
        let merged = merge(service: service, command: command, activeContext: "prod")
        XCTAssertEqual(merged, [
            "A": "svc-base",
            "B": "svc-ctx",
            "C": "cmd-ctx",
        ])
    }

    // MARK: - No command env (regression: string-form commands)

    func testNoCommandEnv_serviceEnvUnchanged() {
        let service = EnvSpec(
            base: [EnvVar(name: "A", value: "svc")],
            contexts: []
        )
        let merged = merge(service: service, command: nil, activeContext: nil)
        XCTAssertEqual(merged, ["A": "svc"])
    }
}

/// String-form commands must continue to produce `NamedCommand` with
/// `env == nil`. This guards against a `norm()` regression where the new
/// shape detection accidentally synthesises an empty env spec.
extension CommandEnvMergeTests {
    func testStringFormCommand_decodesWithEnvNil() throws {
        // Simulate the JSON the bun eval emits for a string-form command:
        // { name, command } — no `env` key.
        let json = #"""
        {
          "services": [
            {
              "type": "project",
              "name": "api",
              "path": "/tmp/api",
              "port": 3000,
              "command": "bun run dev",
              "commands": [
                { "name": "Run tests", "command": "bun test" }
              ]
            }
          ]
        }
        """#
        let raw = try JSONDecoder().decode(RawConfig.self, from: Data(json.utf8))
        let config = try AppConfig.from(raw)
        guard case let .project(f) = config.services[0] else {
            return XCTFail("expected project")
        }
        XCTAssertEqual(f.commands.count, 1)
        XCTAssertEqual(f.commands[0].name, "Run tests")
        XCTAssertNil(f.commands[0].env, "string-form command must have env == nil")
    }

    func testObjectFormCommand_decodesEnv() throws {
        // The shape the bun eval emits for an object-form command with env.
        let json = #"""
        {
          "services": [
            {
              "type": "project",
              "name": "api",
              "path": "/tmp/api",
              "port": 3000,
              "command": "bun run dev",
              "commands": [
                {
                  "name": "Build",
                  "command": "bun run build",
                  "env": {
                    "vars": [
                      { "name": "NODE_ENV", "value": "production" }
                    ],
                    "contexts": [
                      {
                        "name": "staging",
                        "vars": [
                          { "name": "SOURCEMAPS", "value": "true" }
                        ]
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
        """#
        let raw = try JSONDecoder().decode(RawConfig.self, from: Data(json.utf8))
        let config = try AppConfig.from(raw)
        guard case let .project(f) = config.services[0] else {
            return XCTFail("expected project")
        }
        let env = try XCTUnwrap(f.commands[0].env)
        XCTAssertEqual(env.base, [EnvVar(name: "NODE_ENV", value: "production")])
        XCTAssertEqual(env.contexts, [
            EnvContext(name: "staging", vars: [EnvVar(name: "SOURCEMAPS", value: "true")]),
        ])
    }
}
