import Foundation

/// Container naming convention. Containers we start are prefixed `matisa.` so
/// the discovery loop can tell "we started this" from "the user started this
/// directly with `docker run`."
public enum MatisaContainer {
    public static func name(for serviceName: String) -> String {
        "matisa.\(serviceName)"
    }
}

public extension DockerContainer {
    /// First host-side port parsed from the `Ports` column of `docker ps`.
    /// e.g. "0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp" → 5432.
    var firstHostPort: Int? {
        for chunk in ports.split(separator: ",") {
            let s = chunk.trimmingCharacters(in: .whitespaces)
            guard let arrow = s.range(of: "->") else { continue }
            let left = s[..<arrow.lowerBound]
            guard let colon = left.lastIndex(of: ":") else { continue }
            let portStr = left[left.index(after: colon)...]
            if let p = Int(portStr) { return p }
        }
        return nil
    }
}

public extension DockerComposeStack {
    /// True when this stack's `ConfigFiles` list (comma-separated) contains
    /// the given compose-file URL. Path comparison is plain string equality
    /// against `URL.path`; symlinked compose files may not match, but that's
    /// not a practical concern in dev setups.
    func matches(file: URL) -> Bool {
        let target = file.path
        return configFiles.split(separator: ",").contains { chunk in
            chunk.trimmingCharacters(in: .whitespaces) == target
        }
    }
}
