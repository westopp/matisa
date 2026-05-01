import Foundation

/// Loads and evaluates `~/.config/matisa/services.ts` by shelling out
/// to bun. Caches the result by file mtime — re-evaluates only when the file
/// changes on disk.
@MainActor
final class ConfigLoader {
    private(set) var lastConfig: AppConfig?
    private(set) var lastError: ConfigError?
    private var lastMtime: Date?

    /// Load (or re-load) the config. Returns the cached config if mtime hasn't
    /// changed. Errors are stored on the loader and also thrown.
    func load() async throws -> AppConfig {
        let url = Paths.configFile

        guard FileManager.default.fileExists(atPath: url.path) else {
            let err = ConfigError.configMissing(url)
            self.lastError = err
            throw err
        }

        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let mtime = attrs?[.modificationDate] as? Date

        if let cached = lastConfig, let lastMtime, mtime == lastMtime {
            return cached
        }

        let bunPath = Shell.which("bun")
        guard let bun = bunPath else {
            let err = ConfigError.bunMissing
            self.lastError = err
            throw err
        }

        // Normalise `build` (when an object) and `scripts` from
        // Record<string, string> to an ordered array of { name, command }
        // before JSON.stringify, since NSJSONSerialization on Apple platforms
        // doesn't preserve object key order.
        let script = """
        const c = (await import('\(url.path)')).default;
        const out = typeof c === 'function' ? await c() : c;
        const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v))
          ? Object.entries(v).map(([name, command]) => ({ name, command }))
          : v;
        if (out && Array.isArray(out.services)) {
          out.services = out.services.map((s) => ({
            ...s,
            build: typeof s?.build === 'string' ? s.build : norm(s?.build),
            scripts: norm(s?.scripts),
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
