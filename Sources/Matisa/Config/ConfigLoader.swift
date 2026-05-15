import Foundation
import MatisaCore

/// Loads and evaluates `~/.config/matisa/services.ts`.
///
/// Phase 2a: prefers the engine over UDS — if the engine is reachable, the
/// app reads the bun-evaluated JSON from `config.get`. Falls back to running
/// bun directly when the engine is down, so the app keeps working in
/// dev / pre-install scenarios.
///
/// Cache key on the local-fallback path is the max mtime across all `.ts`
/// files under the config dir (see `ConfigMtime`), so per-project files
/// split out under `projects/` invalidate the cache too. The engine has
/// its own (identical) cache, so engine-served calls are also cheap when
/// nothing has changed.
@MainActor
final class ConfigLoader {
    private(set) var lastConfig: AppConfig?
    private(set) var lastError: ConfigError?
    private(set) var lastSource: Source = .none
    private var lastMtime: Date?

    enum Source: Sendable { case none, engine, local }

    /// Load (or re-load) the config. Tries the engine first; on any
    /// transport-level failure (engine unreachable, decode error) falls back
    /// to running bun locally. RPC-level errors from the engine (bun missing
    /// on the engine's side, etc.) also trigger fallback so the user isn't
    /// blocked by an engine misconfiguration.
    func load() async throws -> AppConfig {
        // Try the engine first.
        if let config = try? await loadFromEngine() {
            self.lastConfig = config
            self.lastError = nil
            self.lastSource = .engine
            return config
        }
        // Fall back to local bun.
        let config = try await loadLocally()
        self.lastSource = .local
        return config
    }

    /// Ask the engine for the raw bun JSON and decode it.
    private func loadFromEngine() async throws -> AppConfig {
        let data: Data
        do {
            data = try await EngineClient.shared.callRaw("config.get")
        } catch {
            throw error
        }
        let raw: RawConfig
        do {
            raw = try JSONDecoder().decode(RawConfig.self, from: data)
        } catch {
            throw ConfigError.parseFailed("engine returned undecodable config: \(error)")
        }
        return try AppConfig.from(raw)
    }

    /// Original direct-bun path. Used when the engine is unreachable.
    private func loadLocally() async throws -> AppConfig {
        let url = Paths.configFile

        guard FileManager.default.fileExists(atPath: url.path) else {
            let err = ConfigError.configMissing(url)
            self.lastError = err
            throw err
        }

        // Cache key: max mtime across all `.ts` files under the config dir,
        // so per-project files split out under `projects/` also invalidate
        // the cache (not just edits to services.ts).
        let configDir = url.deletingLastPathComponent()
        let mtime = ConfigMtime.latest(under: configDir)

        if let cached = lastConfig, let lastMtime, mtime == lastMtime {
            return cached
        }

        let bunPath = Shell.which("bun")
        guard let bun = bunPath else {
            let err = ConfigError.bunMissing
            self.lastError = err
            throw err
        }

        // Normalise `commands` from Record<string, string> to an ordered
        // array of { name, command } before JSON.stringify, since
        // NSJSONSerialization on Apple platforms doesn't preserve object
        // key order. Same goes for `env` — string values become base vars,
        // object values become named contexts.
        let script = """
        const c = (await import('\(url.path)')).default;
        const out = typeof c === 'function' ? await c() : c;
        const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v))
          ? Object.entries(v).map(([name, command]) => ({ name, command }))
          : v;
        const splitEnv = (e) => {
          if (!e || typeof e !== 'object' || Array.isArray(e)) return undefined;
          const vars = [];
          const contexts = [];
          for (const [k, v] of Object.entries(e)) {
            if (v == null) continue;
            if (typeof v === 'object' && !Array.isArray(v)) {
              const cvars = [];
              for (const [ck, cv] of Object.entries(v)) {
                if (cv == null) continue;
                if (typeof cv === 'object') continue;
                cvars.push({ name: ck, value: String(cv) });
              }
              contexts.push({ name: k, vars: cvars });
            } else {
              vars.push({ name: k, value: String(v) });
            }
          }
          return { vars, contexts };
        };
        if (out && Array.isArray(out.services)) {
          out.services = out.services.map((s) => ({
            ...s,
            commands: norm(s?.commands),
            env: splitEnv(s?.env),
          }));
        }
        process.stdout.write(JSON.stringify(out));
        """

        let stdout: String
        do {
            stdout = try await Shell.runCapturing(executable: bun, arguments: ["-e", script])
        } catch let ShellError.nonZeroExit(_, stderr) {
            let err = ConfigError.evalFailed(stderr: stderr)
            self.lastError = err
            throw err
        }

        guard let data = stdout.data(using: .utf8) else {
            let err = ConfigError.parseFailed("empty output")
            self.lastError = err
            throw err
        }

        let raw: RawConfig
        do {
            raw = try JSONDecoder().decode(RawConfig.self, from: data)
        } catch {
            let err = ConfigError.parseFailed(String(describing: error))
            self.lastError = err
            throw err
        }

        let config = try AppConfig.from(raw)
        self.lastConfig = config
        self.lastMtime = mtime
        self.lastError = nil
        return config
    }

    /// Forget the cached value, forcing the next `load()` to re-evaluate.
    func invalidate() {
        lastConfig = nil
        lastMtime = nil
    }
}
