import Foundation

/// Pure merge function: takes the loaded config plus a discovery snapshot plus
/// the on-disk spawn records and produces the merged `[Service]` lists that
/// the UI renders. Same logic the app used to run inline inside
/// `ServiceStore.refresh()`; lifted out so the engine and the app's local
/// fallback path can both call it.
///
/// Pure: no syscalls, no I/O, no Process spawns. Callers pre-compute the
/// inputs that would require I/O (`liveSpawnPIDs` via `kill(pid, 0)`,
/// `appNamesByPID` via lsof + manifest read).
public enum ServiceMerge {

    public struct Result: Sendable {
        public let managed: [Service]
        public let unmanaged: [Service]
        /// `serviceID`s of `PersistedSpawn` rows whose PID is no longer alive.
        /// Callers that own the state file (the app's fallback path today,
        /// the engine after Phase 2c) should remove these. The engine
        /// currently ignores this for the file-owned-by-app reasons in the
        /// Phase 2b.2 plan.
        public let deadSpawnIDs: Set<String>
    }

    public static func merge(
        config: AppConfig,
        snapshot: DiscoverySnapshot,
        spawns: [PersistedSpawn],
        liveSpawnPIDs: Set<Int32>,
        appNamesByPID: [Int32: String]
    ) -> Result {
        let ports = snapshot.ports
        let containers = snapshot.dockerDaemonRunning ? snapshot.containers : []
        let composeStacks = snapshot.dockerDaemonRunning ? snapshot.composeStacks : []
        let now = snapshot.takenAt

        var managed: [Service] = []
        var matchedPIDs: Set<Int32> = []
        var matchedManagedPorts: Set<Int> = []
        var deadSpawnIDs: Set<String> = []

        for spec in config.services {
            switch spec {
            case .project(let f):
                let id = "project:\(f.name)"
                let listening = ports.first(where: { $0.port == f.port })
                let ourSpawn = spawns.first(where: { $0.serviceID == id })
                let aliveSpawn = ourSpawn.flatMap { liveSpawnPIDs.contains($0.pid) ? $0 : nil }

                let state: ServiceState
                if let alive = aliveSpawn {
                    // Our spawn wins regardless of whether lsof has caught up
                    // (vite takes a few seconds to bind) and regardless of
                    // whether the listening PID matches ours (npm spawns vite
                    // as a child — PIDs differ).
                    // Claim the spawn pid unconditionally so a dev server that
                    // chose a non-configured port doesn't re-surface as an
                    // unmanaged duplicate of itself.
                    matchedPIDs.insert(alive.pid)
                    if let lp = listening {
                        matchedPIDs.insert(lp.pid)
                        matchedManagedPorts.insert(lp.port)
                    }
                    state = .running(pid: alive.pid, since: alive.startedAt)
                } else if let lp = listening {
                    matchedPIDs.insert(lp.pid)
                    matchedManagedPorts.insert(lp.port)
                    if ourSpawn != nil { deadSpawnIDs.insert(id) }
                    state = .unmanaged(pid: lp.pid)
                } else {
                    if ourSpawn != nil { deadSpawnIDs.insert(id) }
                    state = .stopped
                }

                managed.append(Service(
                    spec: spec,
                    state: state,
                    logsPath: CorePaths.logFile(for: id)
                ))

            case .docker(let f):
                let cname = MatisaContainer.name(for: f.name)
                let container = containers.first(where: { $0.name == cname })
                let listening = ports.first(where: { $0.port == f.port })
                let state: ServiceState
                if let container, container.isRunning {
                    if let lp = listening {
                        matchedPIDs.insert(lp.pid)
                        matchedManagedPorts.insert(lp.port)
                    }
                    state = .running(pid: 0, since: now)
                } else if let lp = listening {
                    matchedPIDs.insert(lp.pid)
                    matchedManagedPorts.insert(lp.port)
                    state = .unmanaged(pid: lp.pid)
                } else {
                    state = .stopped
                }
                managed.append(Service(
                    spec: spec,
                    state: state,
                    logsPath: CorePaths.logFile(for: "docker:\(f.name)")
                ))

            case .compose(let f):
                // Match by file path, not by name — the compose file's own
                // `name:` directive may differ from matisa's config name.
                let stack = composeStacks.first(where: { $0.matches(file: f.file) })
                let isRunning = stack.map { $0.status.lowercased().contains("running") } ?? false
                if isRunning {
                    for cp in f.ports {
                        if let lp = ports.first(where: { $0.port == cp.host }) {
                            matchedPIDs.insert(lp.pid)
                            matchedManagedPorts.insert(lp.port)
                        }
                    }
                }
                let state: ServiceState = isRunning ? .running(pid: 0, since: now) : .stopped
                managed.append(Service(
                    spec: spec,
                    state: state,
                    logsPath: CorePaths.logFile(for: "compose:\(f.name)")
                ))

            case .unmanaged:
                continue
            }
        }

        // Unmanaged synthesis: dev-y listening ports we didn't match above.
        var unmanaged: [Service] = []
        var seenPIDs: Set<Int32> = []
        for lp in ports
        where !matchedPIDs.contains(lp.pid) && !matchedManagedPorts.contains(lp.port) {
            guard UnmanagedHeuristics.looksLikeDevServer(lp) else { continue }
            if lp.pid <= 1 { continue }
            if seenPIDs.contains(lp.pid) { continue }
            seenPIDs.insert(lp.pid)
            unmanaged.append(Service(
                spec: .unmanaged(UnmanagedFields(
                    kind: .process(
                        pid: lp.pid,
                        command: lp.command,
                        port: lp.port,
                        appName: appNamesByPID[lp.pid]
                    )
                )),
                state: .unmanaged(pid: lp.pid),
                logsPath: nil
            ))
        }

        // Unmanaged containers: anything we didn't start, surfaced here so the
        // user can flip them on/off from one place. Use the resolved docker
        // project name (via file-path match) when available — falls back to
        // the matisa-config name when the stack hasn't been brought up yet.
        let knownComposeNames = Set(config.services.compactMap { spec -> String? in
            guard case .compose(let f) = spec else { return nil }
            if let stack = composeStacks.first(where: { $0.matches(file: f.file) }) {
                return stack.name
            }
            return f.name
        })
        for c in containers {
            if c.name.hasPrefix("matisa.") { continue }
            if knownComposeNames.contains(where: {
                c.name.hasPrefix("\($0)-") || c.name.hasPrefix("\($0)_") || c.name == $0
            }) { continue }
            let cstate: ServiceState = c.isRunning ? .running(pid: 0, since: now) : .stopped
            unmanaged.append(Service(
                spec: .unmanaged(UnmanagedFields(
                    kind: .container(name: c.name, image: c.image, port: c.firstHostPort)
                )),
                state: cstate,
                logsPath: nil
            ))
        }

        return Result(
            managed: managed.sorted(by: managedSort),
            unmanaged: unmanaged.sorted(by: unmanagedSort),
            deadSpawnIDs: deadSpawnIDs
        )
    }

    // MARK: - Sort keys (must match what the app produced previously so the UI
    // doesn't visibly reshuffle when callers switch over).

    private static func managedSort(_ a: Service, _ b: Service) -> Bool {
        let order: [ServiceKind: Int] = [.project: 0, .docker: 1, .compose: 2, .unmanaged: 99]
        let ak = order[a.kind] ?? 99
        let bk = order[b.kind] ?? 99
        if ak != bk { return ak < bk }
        return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
    }

    private static func unmanagedSort(_ a: Service, _ b: Service) -> Bool {
        (a.spec.exposedPorts.first?.port ?? 0) < (b.spec.exposedPorts.first?.port ?? 0)
    }
}
