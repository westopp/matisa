import Foundation
import Darwin

/// Sync POSIX helpers used by the merge: liveness checks for persisted spawn
/// PIDs, app-name resolution for unmanaged dev processes. Mirrors the app's
/// `ProcessSupervisor.isAlive` and `ProcessIntrospect.resolveAppNames`.
enum SyncProcess {

    /// True when `pid` exists (or exists but we lack permission to signal it).
    /// Same `kill(pid, 0)` trick the app's supervisor uses.
    static func isAlive(pid: pid_t) -> Bool {
        Darwin.kill(pid, 0) == 0 || errno == EPERM
    }

    /// Returns the subset of `pids` that are currently alive. Single sweep so
    /// the merge can do one liveness check per snapshot rather than per call
    /// site.
    static func livePIDs(of pids: [pid_t]) -> Set<pid_t> {
        var alive: Set<pid_t> = []
        for pid in pids where isAlive(pid: pid) {
            alive.insert(pid)
        }
        return alive
    }
}

/// Resolve human-friendly application names for foreign processes by looking
/// at each pid's working directory and any project manifest found there.
/// Sync port of the app's `ProcessIntrospect`.
enum SyncProcessIntrospect {

    /// Best-effort name lookup. Returns only the pids that resolved; callers
    /// fall back to the raw command/port for the rest.
    static func resolveAppNames(for pids: [Int32]) -> [Int32: String] {
        guard !pids.isEmpty else { return [:] }
        let cwds = cwds(for: pids)
        var result: [Int32: String] = [:]
        for (pid, cwd) in cwds {
            if let name = appName(at: cwd) {
                result[pid] = name
            }
        }
        return result
    }

    /// Batch one `lsof` invocation across all pids to grab their cwds.
    private static func cwds(for pids: [Int32]) -> [Int32: URL] {
        let pidArg = pids.map(String.init).joined(separator: ",")
        let r = SyncShell.runCapturing(
            executable: "/usr/sbin/lsof",
            arguments: ["-a", "-p", pidArg, "-d", "cwd", "-Fpn"]
        )
        guard r.exitCode == 0, let raw = String(data: r.stdout, encoding: .utf8) else {
            return [:]
        }
        var out: [Int32: URL] = [:]
        var current: Int32?
        for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let head = line.first else { continue }
            let body = String(line.dropFirst())
            switch head {
            case "p":
                current = Int32(body)
            case "n":
                if let pid = current, !body.isEmpty {
                    out[pid] = URL(fileURLWithPath: body)
                }
            default:
                continue
            }
        }
        return out
    }

    /// Walk up to a few levels looking for a recognisable manifest.
    private static func appName(at cwd: URL) -> String? {
        var dir = cwd
        for _ in 0..<3 {
            if let n = packageJSONName(dir) { return n }
            if let n = cargoTomlName(dir) { return n }
            if let n = pyprojectName(dir) { return n }
            if let n = goModName(dir) { return n }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    private static func packageJSONName(_ dir: URL) -> String? {
        let url = dir.appendingPathComponent("package.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = obj["name"] as? String,
              !name.isEmpty
        else { return nil }
        return name
    }

    private static func cargoTomlName(_ dir: URL) -> String? {
        let url = dir.appendingPathComponent("Cargo.toml")
        guard let raw = try? String(contentsOf: url) else { return nil }
        return tomlNameInSection(raw, section: "package")
    }

    private static func pyprojectName(_ dir: URL) -> String? {
        let url = dir.appendingPathComponent("pyproject.toml")
        guard let raw = try? String(contentsOf: url) else { return nil }
        return tomlNameInSection(raw, section: "project")
            ?? tomlNameInSection(raw, section: "tool.poetry")
    }

    private static func goModName(_ dir: URL) -> String? {
        let url = dir.appendingPathComponent("go.mod")
        guard let raw = try? String(contentsOf: url) else { return nil }
        for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("module ") else { continue }
            let module = trimmed
                .dropFirst("module ".count)
                .trimmingCharacters(in: .whitespaces)
            let last = (module as NSString).lastPathComponent
            return last.isEmpty ? nil : last
        }
        return nil
    }

    /// Tiny TOML-ish reader: find `name = "..."` inside `[section]`. Doesn't
    /// understand nested tables beyond the literal section header match —
    /// fine for `[package]`, `[project]`, `[tool.poetry]`.
    private static func tomlNameInSection(_ raw: String, section: String) -> String? {
        var inSection = false
        for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") {
                let header = trimmed.dropFirst().dropLast()
                inSection = (header == section)
                continue
            }
            guard inSection else { continue }
            guard trimmed.hasPrefix("name") else { continue }
            guard let eq = trimmed.firstIndex(of: "=") else { continue }
            let value = trimmed[trimmed.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if let unquoted = unquote(value) { return unquoted }
        }
        return nil
    }

    private static func unquote(_ s: String) -> String? {
        var v = s
        if let hash = v.firstIndex(of: "#") {
            v = String(v[..<hash]).trimmingCharacters(in: .whitespaces)
        }
        if (v.hasPrefix("\"") && v.hasSuffix("\""))
            || (v.hasPrefix("'") && v.hasSuffix("'")) {
            v = String(v.dropFirst().dropLast())
        }
        return v.isEmpty ? nil : v
    }
}
