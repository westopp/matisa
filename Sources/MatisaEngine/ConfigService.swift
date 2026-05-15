import Foundation
import MatisaCore

/// Loads `~/.config/matisa/services.ts` by shelling out to bun, mirrors the
/// app's `ConfigLoader` byte-for-byte (same eval script, same caching by
/// max-mtime across all `.ts` files under the config dir — see
/// `ConfigMtime`). The result is raw JSON bytes; the wire shape is whatever
/// the bun eval emits, which the app already knows how to decode.
///
/// Thread-safe: all access goes through a serial queue. A single in-flight
/// bun call blocks the queue for the duration (~100–500ms first time,
/// near-zero cached) but doesn't block other connections, since the
/// connection workers are on a separate concurrent queue.
final class ConfigService {

    /// `~/.config/matisa/services.ts`
    static let defaultConfigPath: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.config/matisa/services.ts"
    }()

    private let configPath: String
    private let queue = DispatchQueue(label: "engine.config", qos: .userInitiated)
    private var cached: Cache?
    private var lastError: String?
    private var lastLoadAttemptAt: Date?

    private struct Cache {
        let json: Data
        let mtime: Date
        let loadedAt: Date
    }

    struct Status: Encodable {
        let loaded: Bool
        let configPath: String
        let lastLoadAt: String?
        let mtime: String?
        let error: String?
    }

    init(configPath: String = ConfigService.defaultConfigPath) {
        self.configPath = configPath
    }

    /// Diagnostic snapshot. Cheap; never re-runs bun.
    func status() -> Status {
        queue.sync {
            Status(
                loaded: cached != nil,
                configPath: configPath,
                lastLoadAt: cached?.loadedAt.iso8601String(),
                mtime: cached?.mtime.iso8601String(),
                error: lastError
            )
        }
    }

    /// Returns the raw JSON bytes produced by the bun eval. Re-evaluates only
    /// when the config file's mtime has changed. Throws on missing file,
    /// missing bun, or non-zero exit from bun.
    func get() throws -> Data {
        try queue.sync {
            lastLoadAttemptAt = Date()

            let url = URL(fileURLWithPath: configPath)
            guard FileManager.default.fileExists(atPath: url.path) else {
                let msg = "config file not found at \(url.path)"
                lastError = msg
                throw RPCError.internalError(msg)
            }

            // Cache key: max mtime across all `.ts` files under the config
            // dir, so per-project files split out under `projects/` also
            // invalidate the cache (not just edits to services.ts).
            let configDir = url.deletingLastPathComponent()
            let mtime = ConfigMtime.latest(under: configDir)

            if let c = cached, c.mtime == mtime {
                return c.json
            }

            do {
                let json = try runBun(configPath: url.path)
                cached = Cache(json: json, mtime: mtime, loadedAt: Date())
                lastError = nil
                return json
            } catch let err as RPCError {
                lastError = err.message
                throw err
            } catch {
                let msg = "\(error)"
                lastError = msg
                throw RPCError.internalError(msg)
            }
        }
    }

    /// Eager preload at engine boot. Errors are stored on `lastError` but
    /// not surfaced — the engine starts whether or not config is valid.
    func preload() {
        _ = try? get()
    }

    // MARK: - bun integration

    /// Same eval script as the app's `ConfigLoader`. Keep in sync if either
    /// side changes — both speak this exact shape.
    private func runBun(configPath: String) throws -> Data {
        guard let bun = Self.findBun() else {
            throw RPCError.internalError("bun is not installed or not in PATH")
        }

        let script = """
        const c = (await import('\(configPath)')).default;
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

        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        process.arguments = ["-e", script]
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            throw RPCError.internalError("failed to spawn bun: \(error)")
        }
        process.waitUntilExit()

        let stdout = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderr = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrText = String(data: stderr, encoding: .utf8) ?? ""

        if process.terminationStatus != 0 {
            throw RPCError.internalError("bun eval failed (exit \(process.terminationStatus)):\n\(stderrText)")
        }
        if stdout.isEmpty {
            throw RPCError.internalError("bun produced empty output")
        }
        // Validate it parses; reject garbage rather than handing it to clients.
        if (try? JSONSerialization.jsonObject(with: stdout)) == nil {
            throw RPCError.internalError("bun output is not valid JSON")
        }
        return stdout
    }

    /// Mirror of `Shell.which("bun")` from the app — well-known paths first,
    /// then a login-zsh fallback so we pick up nvm/fnm-managed installs.
    private static func findBun() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
            "\(home)/.bun/bin/bun",
            "\(home)/.local/bin/bun",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-l", "-c", "command -v bun"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let result = (String(data: data, encoding: .utf8) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return result.isEmpty ? nil : result
        } catch {
            return nil
        }
    }
}

private extension Date {
    func iso8601String() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: self)
    }
}
