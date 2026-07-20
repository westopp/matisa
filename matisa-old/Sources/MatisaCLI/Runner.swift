import Foundation
import MatisaCore

/// One method per resolved `Command`. The runner owns the EngineClient
/// instance for this invocation (the CLI is one-shot, so we don't share
/// the actor-singleton across runs — `--socket` overrides need their own
/// client). The dispatch site keeps engine-unreachable handling in one
/// place: if `--ensure-engine` is set, we proactively spawn; otherwise we
/// translate the error into exit code 2.
enum Runner {

    static func run(parsed: Parsed) async throws {
        switch parsed.command {
        case .help(let topic):
            Help.print(topic: topic)

        case .version:
            await runVersion(options: parsed.options)

        case .list:
            try await runList(options: parsed.options)

        case .start(let id):
            try await runLifecycle(method: "services.start", id: id, lifecycle: true,
                                   options: parsed.options, verb: "started")

        case .stop(let id):
            try await runLifecycle(method: "services.stop", id: id, lifecycle: false,
                                   options: parsed.options, verb: "stopped")

        case .restart(let id):
            try await runLifecycle(method: "services.restart", id: id, lifecycle: true,
                                   options: parsed.options, verb: "restarted")

        case .logs(let id, let lines, let all):
            try runLogs(id: id, lines: lines, all: all, options: parsed.options)

        case .engineStatus:
            try await runEngineStatus(options: parsed.options)

        case .engineStart:
            try await runEngineStart(options: parsed.options)

        case .engineStop:
            try await runEngineStop(options: parsed.options)
        }
    }

    // MARK: - Engine reachability

    /// Build an EngineClient honoring `--socket`. If `--ensure-engine` is
    /// set, proactively spawn the engine before returning so the caller
    /// doesn't have to retry-on-unreachable.
    private static func client(for options: Options) async throws -> EngineClient {
        let socket = options.socketPath ?? EngineClient.defaultSocketPath()
        if options.ensureEngine {
            do {
                _ = try await EngineLauncher.ensureRunning(socketPath: socket)
            } catch let err as EngineLauncher.LaunchError {
                throw CLIError.spawn("could not start engine: \(err)")
            } catch {
                throw CLIError.spawn("could not start engine: \(error)")
            }
        }
        return EngineClient(socketPath: socket)
    }

    /// Translate `EngineClient.ClientError` into `CLIError` with the right
    /// exit code. Use at every RPC call site so we get consistent stderr
    /// formatting and `$?` semantics.
    private static func translate(_ error: Error) -> CLIError {
        switch error {
        case EngineClient.ClientError.engineUnreachable(let msg):
            return CLIError.unreachable("engine not reachable (\(msg))\n  start it with: matisa engine start")
        case EngineClient.ClientError.rpcError(let code, let msg):
            return CLIError.rpc(code: code, message: msg)
        case EngineClient.ClientError.protocolError(let msg):
            return CLIError.unreachable("engine protocol error: \(msg)")
        case EngineClient.ClientError.decodeFailed(let msg):
            return CLIError.unreachable("engine response decode failed: \(msg)")
        case let cliErr as CLIError:
            return cliErr
        default:
            return CLIError(exitCode: 1, message: "\(error)")
        }
    }

    // MARK: - Commands

    private static func runVersion(options: Options) async {
        Output.println("matisa \(CLIVersion.value)")
        // Best-effort engine version — never errors out, since `matisa
        // --version` should work without the engine running.
        //
        // Tight 1s timeout instead of the 5s default. `--version` should
        // feel instant; if the engine isn't reachable (down, or stuck
        // with a leaked listening fd), fall through to "engine not
        // running" without making the user wait. The default timeout
        // applies to real RPC paths like `list` / `start` where the
        // engine might legitimately need more time.
        let socket = options.socketPath ?? EngineClient.defaultSocketPath()
        let client = EngineClient(socketPath: socket, timeoutSeconds: 1)
        if let info = try? await client.call("engine.status", as: EngineStatusInfo.self) {
            Output.println("engine \(info.version)")
        } else {
            Output.println("engine not running")
        }
    }

    private static func runList(options: Options) async throws {
        let client = try await client(for: options)
        do {
            if options.jsonOutput {
                let raw = try await client.callRaw("services.snapshot")
                try Output.printJSON(raw)
            } else {
                let snap: ServicesSnapshot = try await client.call(
                    "services.snapshot", as: ServicesSnapshot.self
                )
                Output.renderServicesTable(snap)
            }
        } catch {
            throw translate(error)
        }
    }

    private static func runLifecycle(
        method: String,
        id: String,
        lifecycle: Bool,
        options: Options,
        verb: String
    ) async throws {
        let client = try await client(for: options)
        // `lifecycle: true` → method takes `ServiceLifecycleParams` (carries
        // the active env context name). The CLI doesn't know which context
        // is "active" — that's a UI concept owned by the app's settings —
        // so we always pass nil. The engine then uses the project's base
        // env only, which matches the engine's pre-fix behaviour and is
        // also what a CI/script user would want by default.
        let params: Encodable = lifecycle
            ? ServiceLifecycleClientParams(id: id, activeEnvContext: nil)
            : ServiceIDParams(id: id)
        do {
            if options.jsonOutput {
                let raw = try await client.callRaw(method, params: params)
                try Output.printJSON(raw)
            } else {
                _ = try await client.call(method, params: params, as: EmptyResponse.self)
                Output.println("\(verb): \(id)")
            }
        } catch {
            throw translate(error)
        }
    }

    /// `matisa logs <id>` — one-shot tail of the on-disk log file. The
    /// engine writes these via `LogRotator`; the CLI reads them directly
    /// because the path is shared via `CorePaths` and going through an
    /// RPC method buys nothing in Phase 4. The streaming variant (`-f`)
    /// is Phase 5 because it needs server-pushed notifications, which the
    /// envelope doesn't support today.
    ///
    /// Default tail size is 200 lines; `--all` prints the whole file;
    /// `--lines N` overrides. Missing log file is *not* an error — the
    /// service may never have run, which is a normal state to query —
    /// we just emit a single explanatory line to stderr and exit 0.
    private static func runLogs(id: String, lines: Int?, all: Bool, options: Options) throws {
        let path = CorePaths.logFile(for: id)
        guard FileManager.default.fileExists(atPath: path.path) else {
            FileHandle.standardError.write(
                Data("matisa: no logs for \(id) (file \(path.path) does not exist)\n".utf8)
            )
            return
        }

        let data: Data
        do {
            data = try Data(contentsOf: path)
        } catch {
            throw CLIError(exitCode: 1, message: "failed to read log file \(path.path): \(error)")
        }

        // Logs are size-bounded by `LogRotator` (the engine's rotator caps
        // each file before rotating), so reading the whole file and slicing
        // tail-lines in memory is fine at production sizes. If that
        // assumption ever breaks we'll add a reverse-seek-from-end pass.
        let text = String(data: data, encoding: .utf8) ?? ""
        let allLines = text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" })
        let slice: ArraySlice<Substring>
        if all {
            slice = allLines[...]
        } else {
            let n = lines ?? 200
            // `split` with `omittingEmptySubsequences: false` leaves a
            // trailing empty element when the file ends in '\n' — drop it
            // before counting so `--lines 5` returns 5 real lines, not 4.
            let trimmed = allLines.last?.isEmpty == true ? allLines.dropLast() : allLines[...]
            slice = trimmed.suffix(n)
        }

        let out = FileHandle.standardOutput
        if options.jsonOutput {
            // JSONL: one `{"line": "..."}` per record. Matches the shape
            // Phase 5's `services.logs.subscribe` notifications will use
            // (where additional fields like `ts` and `pid` get layered on),
            // so scripts written against the CLI's --json output should
            // forward-port cleanly.
            for line in slice {
                let obj: [String: String] = ["line": String(line)]
                if let bytes = try? JSONSerialization.data(
                    withJSONObject: obj, options: [.withoutEscapingSlashes]
                ) {
                    out.write(bytes)
                    out.write(Data([0x0A]))
                }
            }
        } else {
            for line in slice {
                out.write(Data(line.utf8))
                out.write(Data([0x0A]))
            }
        }
    }

    private static func runEngineStatus(options: Options) async throws {
        let client = try await client(for: options)
        do {
            if options.jsonOutput {
                let raw = try await client.callRaw("engine.status")
                try Output.printJSON(raw)
            } else {
                let info: EngineStatusInfo = try await client.call(
                    "engine.status", as: EngineStatusInfo.self
                )
                Output.renderEngineStatus(info)
            }
        } catch {
            throw translate(error)
        }
    }

    private static func runEngineStart(options: Options) async throws {
        let socket = options.socketPath ?? EngineClient.defaultSocketPath()
        do {
            let result = try await EngineLauncher.ensureRunning(socketPath: socket)
            if result.alreadyRunning {
                Output.println("engine already running at \(socket)")
            } else {
                Output.println("engine started at \(socket)")
            }
        } catch let err as EngineLauncher.LaunchError {
            throw CLIError.spawn("\(err)")
        } catch {
            throw CLIError.spawn("\(error)")
        }
    }

    private static func runEngineStop(options: Options) async throws {
        let socket = options.socketPath ?? EngineClient.defaultSocketPath()
        let client = EngineClient(socketPath: socket)
        // Cheap reachability probe first so "engine stop" against a dead
        // engine reports something cleaner than a generic transport error.
        if await client.isReachable() == false {
            Output.println("engine not running at \(socket)")
            return
        }
        do {
            try await client.shutdown()
            // Poll briefly so we report a meaningful exit. The engine acks
            // and then exits ~100ms later (see Engine.swift's shutdown
            // method), so a 2s window is plenty.
            let deadline = Date().addingTimeInterval(2.0)
            while Date() < deadline {
                if await client.isReachable() == false { break }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            Output.println("engine stopped")
        } catch {
            throw translate(error)
        }
    }
}
