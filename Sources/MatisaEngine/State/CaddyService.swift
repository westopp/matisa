import Foundation
import MatisaCore

/// Engine-side owner of the Caddy reverse proxy lifecycle. Replaces the app's
/// `BrewServices`-driven start/stop/restart/reload calls plus the
/// `CaddyfileGenerator.write` invocations spread through `ServiceStore`.
///
/// State surface is intentionally narrow:
///   - `running` and `configFile` (via `status()`) — what the app's System
///     panel binds to.
///   - `regenerate()` — render the Caddyfile from current config + services
///     and atomically write it to disk.
///   - `scheduleRegenAndReload()` — the debounced regen+reload pair the app's
///     `scheduleCaddyRegen` used to provide. Several toggles in quick
///     succession coalesce into one regen and one reload. Currently only the
///     engine itself calls this (2e.2 hooks it up to mDNS toggles).
///
/// Caddyfile rendering uses `CaddyfileGenerator` from MatisaCore. Exposures
/// are passed in empty for 2d — Phase 2e.2 will route the engine's
/// `MDNSPublisher` state through here so `<service>.matisa.local` blocks
/// appear in the rendered output.
///
/// Closure-injection on every collaborator keeps the tests self-contained —
/// they don't need a real `ConfigService` round-tripping through bun or a
/// real `ServicesService` driving the merge pipeline.
///
/// Thread-safety: a serial queue gates the debounce-task slot. Action methods
/// themselves are async and run their work on detached EngineShell tasks.
final class CaddyService: @unchecked Sendable {

    private let loadConfig: @Sendable () throws -> AppConfig
    private let loadServicesSnapshot: @Sendable () throws -> ServicesSnapshot

    private let brewProbe: @Sendable () -> [BrewService]
    private let brewStart: @Sendable (String) async throws -> Void
    private let brewStop: @Sendable (String) async throws -> Void
    private let brewRestart: @Sendable (String) async throws -> Void

    private let caddyBinaryLookup: @Sendable () -> String?
    private let runValidate: @Sendable (_ executable: String, _ arguments: [String]) async throws -> Void

    /// Coalesces rapid regen+reload requests. A second call within the 150ms
    /// window cancels the prior pending Task before it can fire. Stored under
    /// the queue so reads-and-writes can't race.
    private let queue = DispatchQueue(label: "engine.caddy")
    private var pendingRegen: Task<Void, Never>?

    /// Debounce window for `scheduleRegenAndReload`. Same value the app used.
    private let debounceNS: UInt64

    /// Production initialiser — wires the real config / services / brew /
    /// shell collaborators. Tests use `init(loadConfig:loadServicesSnapshot:…)`
    /// directly so they can drive the service without a real engine stack.
    convenience init(
        configService: ConfigService,
        servicesService: ServicesService
    ) {
        // Capture references so the closures don't retain `self` if this
        // service is ever held weakly elsewhere.
        let cfg = configService
        let svc = servicesService
        self.init(
            loadConfig: {
                let bytes = try cfg.get()
                do {
                    let raw = try JSONDecoder().decode(RawConfig.self, from: bytes)
                    return try AppConfig.from(raw)
                } catch {
                    throw RPCError.internalError("config decode failed: \(error)")
                }
            },
            loadServicesSnapshot: { try svc.snapshot() }
        )
    }

    init(
        loadConfig: @escaping @Sendable () throws -> AppConfig,
        loadServicesSnapshot: @escaping @Sendable () throws -> ServicesSnapshot,
        brewProbe: @escaping @Sendable () -> [BrewService] = { SyncBrew.list() },
        brewStart: @escaping @Sendable (String) async throws -> Void = EngineBrew.start,
        brewStop: @escaping @Sendable (String) async throws -> Void = EngineBrew.stop,
        brewRestart: @escaping @Sendable (String) async throws -> Void = EngineBrew.restart,
        caddyBinaryLookup: @escaping @Sendable () -> String? = { SyncShell.which("caddy") },
        runValidate: @escaping @Sendable (_ executable: String, _ arguments: [String]) async throws -> Void = {
            executable, arguments in
            _ = try await EngineShell.runCapturingStderrTail(
                executable: executable,
                arguments: arguments,
                timeout: 15
            )
        },
        debounceNS: UInt64 = 150_000_000
    ) {
        self.loadConfig = loadConfig
        self.loadServicesSnapshot = loadServicesSnapshot
        self.brewProbe = brewProbe
        self.brewStart = brewStart
        self.brewStop = brewStop
        self.brewRestart = brewRestart
        self.caddyBinaryLookup = caddyBinaryLookup
        self.runValidate = runValidate
        self.debounceNS = debounceNS
    }

    // MARK: - Status

    /// Cheap snapshot. Probes brew on every call — same shape the discovery
    /// snapshot does, so a missing/never-installed caddy registers as
    /// `running: false` rather than blowing up. `configFile` reflects the
    /// current loaded config; nil when config is unavailable or no caddyfile
    /// is declared.
    func status() -> CaddyServiceInfo {
        let brew = brewProbe()
        let caddy = brew.first(where: { $0.name == "caddy" })
        let configFile = (try? loadConfig())?.caddyfile
        return CaddyServiceInfo(
            running: caddy?.isRunning ?? false,
            configFile: configFile
        )
    }

    // MARK: - Lifecycle

    func start() async throws { try await brewStart("caddy") }
    func stop() async throws { try await brewStop("caddy") }
    func restart() async throws { try await brewRestart("caddy") }

    /// `brew services restart caddy` is the most reliable way to pick up a
    /// regenerated Caddyfile without dropping in-flight connections — matches
    /// the app's pre-2d `reloadCaddy`.
    func reload() async throws { try await brewRestart("caddy") }

    // MARK: - Validate

    /// Run `caddy validate --config <path> --adapter caddyfile`. Non-zero exit
    /// surfaces as `ok: false` with the stderr tail in `message`; exit 0 is
    /// `ok: true` with no message. A missing caddyfile path or missing caddy
    /// binary also returns `ok: false` so the UI can render a single
    /// "validation didn't run" path without a separate error channel.
    func validate() async throws -> CaddyValidationResult {
        let config: AppConfig
        do { config = try loadConfig() } catch {
            return CaddyValidationResult(ok: false, message: "config unavailable: \(error)")
        }
        guard let path = config.caddyfile else {
            return CaddyValidationResult(ok: false, message: "no caddyfile configured")
        }
        guard let bin = caddyBinaryLookup() else {
            return CaddyValidationResult(ok: false, message: "caddy binary not found")
        }
        do {
            try await runValidate(bin, ["validate", "--config", path.path, "--adapter", "caddyfile"])
            return CaddyValidationResult(ok: true, message: nil)
        } catch ShellError.nonZeroExit(_, let stderr) {
            let lastLine = stderr
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .last(where: { !$0.isEmpty })
            return CaddyValidationResult(ok: false, message: lastLine.flatMap { $0.isEmpty ? nil : $0 })
        } catch {
            return CaddyValidationResult(ok: false, message: "\(error)")
        }
    }

    // MARK: - Regenerate

    /// Render the Caddyfile from current config + managed services and write
    /// it atomically. Exposures are empty for 2d — 2e wires them in.
    /// Returns the destination URL, or nil if no caddyfile is configured.
    @discardableResult
    func regenerate() async throws -> URL? {
        let config = try loadConfig()
        let snapshot = try loadServicesSnapshot()
        return try CaddyfileGenerator.write(
            config,
            services: snapshot.managed,
            exposures: [:]
        )
    }

    /// Debounced regenerate-then-reload. Subsequent calls within the 150ms
    /// window cancel the previous pending Task and reset the timer; only the
    /// last one in a burst actually fires. Errors from regen and reload are
    /// swallowed — matches the app's pre-2d `scheduleCaddyRegen` (`try?` on
    /// both `regenerateCaddyfile` and `reloadCaddy`). Used by the
    /// engine-internal exposure-toggle flows (2e.2 plumbing). Not an RPC.
    func scheduleRegenAndReload() {
        queue.sync {
            pendingRegen?.cancel()
            let ns = debounceNS
            pendingRegen = Task { [weak self] in
                try? await Task.sleep(nanoseconds: ns)
                guard !Task.isCancelled else { return }
                guard let self else { return }
                _ = try? await self.regenerate()
                guard !Task.isCancelled else { return }
                try? await self.reload()
            }
        }
    }
}
