import { Context, Effect, Layer, Option } from "effect"
import { randomUUID } from "node:crypto"
import {
  CaddyUnavailable,
  ValidationError,
  type EngineError,
  type ExposureEntry,
  type ExposureSnapshot,
  type Project,
  type ProjectExposures,
  type ProjectId
} from "@matisa/core"
import { ExposuresRepo, ProjectsRepo, type ExposureRecord } from "@matisa/store"
import { AppConfig } from "../../config/config.app-config.js"
import { CADDY_BOOTSTRAP_PATH } from "../../config/config.constants.js"
import { exposureChanged } from "../../shared/events.js"
import { EventsHub } from "../../server/server.events-hub.js"
import { awaitPortBound, foreignListener } from "../supervisor/supervisor.probe.js"
import {
  desiredConfig,
  findCaddyBinary,
  makeAdmin,
  selectLoopbackPort,
  selectWildcardPort,
  slugify,
  superviseCaddy,
  writeBootstrap,
  type CaddyChild,
  type RouteSpec
} from "./exposure.caddy.js"
import { makeMdnsPublisher } from "./exposure.mdns.js"

// ────────────────────────────────────────────────────────────────────────────
// Exposure — the module that makes a project's declared port reachable beyond
// localhost:<port>. Owns one Caddy child (driven live over its admin API — no
// Caddyfile, no restarts) and the dns-sd children for LAN hostnames.
//
// Derivation rules:
//   port declared            → `stable_url` row + http://<slug>.localhost:<p>
//   project.stableUrl false  → no row, no route on the shared server. The
//                              project's own localhost:<port> is untouched —
//                              this only declines the hostname — and LAN stays
//                              its own switch, so a project can be reachable on
//                              the network without a loopback hostname.
//   LAN share toggled on     → `lan` row: <slug>.<domain> via mDNS plus a
//                              dedicated 0.0.0.0 listener on an allocated port.
//                              The shared loopback listener is NOT touched —
//                              one project opting in must not publish the rest.
//   port removed / project gone → rows and routes go with it
//
// Caddy's own two ports are chosen at boot, not assumed: `caddyPorts` below
// probes the configured numbers and moves up until it finds a pair nothing else
// holds, and every URL this module reports is built from what it actually got.
//
// Routes stay up when a project stops — a 502 is diagnosable, a dead hostname
// is not. Exposure therefore reacts to CATALOG changes (via the events hub),
// never to supervisor state. The store is the source of truth; Caddy is a
// projection of it, re-pushed in full (graceful POST /load) on every change.
// ────────────────────────────────────────────────────────────────────────────

export interface ExposureShape {
  readonly snapshot: () => Effect.Effect<ExposureSnapshot, EngineError>
  readonly lanSet: (
    id: ProjectId,
    enabled: boolean
  ) => Effect.Effect<{ readonly entries: ReadonlyArray<ExposureEntry> }, EngineError>
  /** Re-derive rows + routes for one project (catalog changed). */
  readonly reconcile: (projectId: ProjectId) => Effect.Effect<void>
}

export class Exposure extends Context.Tag("Exposure")<Exposure, ExposureShape>() {}

const primaryPort = (p: Project): number | undefined => p.ports[0]?.number

const make = Effect.gen(function* () {
  const config = yield* AppConfig
  const projects = yield* ProjectsRepo
  const exposures = yield* ExposuresRepo
  const hub = yield* EventsHub
  const sem = yield* Effect.makeSemaphore(1)

  // ——— provider boot (degrades cleanly when caddy is absent or the ports are
  // already taken — neither may take the engine down) ———

  const binary = yield* findCaddyBinary().pipe(Effect.option)

  /** Per-boot ownership marker: proves the admin endpoint we talk to is the
   * child we spawned and not, say, the brew-managed caddy on :2019. */
  const ownerToken = randomUUID()

  /** Name whoever holds a port, so the log says why the URL moved. */
  const holderOf = (port: number): Effect.Effect<string> =>
    foreignListener(port).pipe(
      Effect.map((held) =>
        held === undefined
          ? "unavailable"
          : `held by ${held.processName ?? "unknown"} (pid ${held.pid ?? "?"})`
      )
    )

  const caddyPorts = Option.isSome(binary)
    ? yield* Effect.gen(function* () {
        const adminPort = yield* selectLoopbackPort(config.caddyAdminPort)
        if (adminPort === undefined) return undefined
        const httpPort = yield* selectLoopbackPort(config.caddyHttpPort, {
          exclude: [adminPort]
        })
        return httpPort === undefined ? undefined : { adminPort, httpPort }
      })
    : undefined

  if (caddyPorts !== undefined) {
    if (caddyPorts.adminPort !== config.caddyAdminPort) {
      yield* Effect.logWarning(
        `exposure: caddy admin :${config.caddyAdminPort} ${yield* holderOf(
          config.caddyAdminPort
        )} — using :${caddyPorts.adminPort} instead`
      )
    }
    if (caddyPorts.httpPort !== config.caddyHttpPort) {
      yield* Effect.logWarning(
        `exposure: caddy http :${config.caddyHttpPort} ${yield* holderOf(
          config.caddyHttpPort
        )} — stable URLs will use :${caddyPorts.httpPort}`
      )
    }
  }

  /** The port every stable URL is built from — what we got, not what we asked
   * for. Falls back to the configured number only for display when the provider
   * is unusable and there is no live listener to name. */
  const httpPort = caddyPorts?.httpPort ?? config.caddyHttpPort

  const unusableReason: string | undefined = Option.isNone(binary)
    ? "caddy not installed — brew install caddy"
    : caddyPorts === undefined
      ? `no free port for caddy near :${config.caddyAdminPort}/:${config.caddyHttpPort} — stable URLs unavailable`
      : undefined
  const available = unusableReason === undefined

  const opts = {
    adminPort: caddyPorts?.adminPort ?? config.caddyAdminPort,
    httpPort,
    mdnsDomain: config.mdnsDomain,
    ownerToken
  }

  const mdns = yield* makeMdnsPublisher((ip) =>
    Effect.logInfo(`exposure: LAN IP changed → ${ip ?? "none"}`).pipe(
      Effect.zipRight(emitAllLanProjects)
    )
  )

  /** RouteSpecs derived from the store — the single input to desiredConfig. */
  const specsFromStore = Effect.gen(function* () {
    const all = yield* projects.list().pipe(Effect.orElseSucceed(() => []))
    const rows = yield* exposures.listAll().pipe(Effect.orElseSucceed(() => []))
    const specs: Array<RouteSpec> = []
    for (const p of all) {
      const port = primaryPort(p)
      if (port === undefined) continue
      const lanRow = rows.find((r) => r.projectId === p.id && r.kind === "lan" && r.enabled)
      const lanPort = lanRow?.config?.["lanPort"]
      specs.push({
        projectId: p.id,
        slug: slugify(p.name),
        upstreamPort: port,
        ...(p.stableUrl === false ? { stableUrl: false } : {}),
        ...(typeof lanPort === "number" ? { lan: { lanPort } } : {})
      })
    }
    return specs
  })

  const desired = () => specsFromStore.pipe(Effect.map((specs) => desiredConfig(specs, opts)))

  let child: CaddyChild | undefined
  if (Option.isSome(binary) && caddyPorts !== undefined) {
    yield* writeBootstrap(CADDY_BOOTSTRAP_PATH, caddyPorts.adminPort, ownerToken)
    child = yield* superviseCaddy({
      binary: binary.value,
      bootstrapPath: CADDY_BOOTSTRAP_PATH,
      adminPort: caddyPorts.adminPort,
      ownerToken,
      desired,
      awaitReady: awaitPortBound(caddyPorts.adminPort, 10_000),
      onExit: (code) => Effect.logWarning(`exposure: caddy exited (code ${code ?? "?"}) — respawning`),
      onForeignAdmin: (detail) =>
        Effect.logError(`exposure: ${detail} — not pushing config; stable URLs unavailable`)
    })
    yield* Effect.logInfo(
      `exposure: caddy up (http :${caddyPorts.httpPort}, admin :${caddyPorts.adminPort})`
    )
  } else {
    yield* Effect.logWarning(`exposure: ${unusableReason ?? "caddy unusable"}`)
  }

  const admin = makeAdmin(opts.adminPort, ownerToken)
  /** Running AND ours — a caddy we could not identify is not a caddy we use. */
  const running = () => (child?.isRunning() ?? false) && child?.ownershipFault() === undefined

  /** Push the full desired config — graceful in-process swap, never a restart.
   *
   *  Skipped while caddy is not ready, and quietly: the supervisor pushes
   *  `desired()` itself the moment the admin endpoint answers as ours, so a
   *  change made in that window is already accounted for — nothing is lost by
   *  not sending it now. Reporting it was worse than useless: boot reconciles
   *  one project at a time, so a five-project catalog logged five warnings
   *  about a condition that had already resolved by the time anyone read them,
   *  in the log people are told to check when something is actually wrong. */
  const push = available
    ? Effect.suspend(() =>
        child?.isReady() !== true
          ? Effect.logDebug("exposure: caddy not ready yet — its own initial push carries this")
          : desired().pipe(
              Effect.flatMap((cfg) => admin.load(cfg)),
              Effect.tapError((e) =>
                Effect.logWarning(`exposure: config push failed: ${e.detail ?? e.path}`)
              ),
              Effect.ignore
            )
      )
    : Effect.void

  // ——— entry derivation (pure over store rows + provider state) ———

  const entriesFor = (project: Project, rows: ReadonlyArray<ExposureRecord>): Array<ExposureEntry> => {
    const port = primaryPort(project)
    if (port === undefined) return []
    const slug = slugify(project.name)
    const caddyState = !available ? "unavailable" : running() ? "active" : "error"
    const caddyMessage = !available
      ? unusableReason
      : running()
        ? undefined
        : (child?.ownershipFault() ?? "caddy not running")

    // No row, no entry: a project that declined the hostname reports nothing
    // where the URL would be, rather than an entry saying it is switched off —
    // the switch itself lives on the project, and the snapshot is a list of
    // addresses that exist.
    const entries: Array<ExposureEntry> =
      project.stableUrl === false
        ? []
        : [
            {
              kind: "stable_url",
              url: `http://${slug}.localhost:${httpPort}`,
              enabled: true,
              state: caddyState,
              ...(caddyMessage !== undefined ? { message: caddyMessage } : {})
            }
          ]

    const lanRow = rows.find((r) => r.projectId === project.id && r.kind === "lan" && r.enabled)
    if (lanRow) {
      const ip = mdns.currentIp()
      const lanState = caddyState !== "active" ? caddyState : ip === undefined ? "error" : "active"
      const lanMessage =
        caddyMessage ?? (ip === undefined ? "no LAN interface available" : undefined)
      // Both LAN addresses point at the project's DEDICATED listener, never at
      // the shared stable-URL port: that one is loopback-bound, so an off-machine
      // client could not reach it even if we advertised it.
      const lanPort = lanRow.config?.["lanPort"]
      if (typeof lanPort === "number") {
        entries.push({
          kind: "lan",
          url: `http://${slug}.${config.mdnsDomain}:${lanPort}`,
          enabled: true,
          state: lanState,
          ...(lanMessage !== undefined ? { message: lanMessage } : {})
        })
        if (ip !== undefined) {
          entries.push({
            kind: "lan",
            url: `http://${ip}:${lanPort}`,
            enabled: true,
            state: lanState,
            ...(lanMessage !== undefined ? { message: lanMessage } : {})
          })
        }
      }
    }
    return entries
  }

  const emitFor = (projectId: ProjectId): Effect.Effect<ReadonlyArray<ExposureEntry>> =>
    Effect.gen(function* () {
      const project = yield* projects.get(projectId).pipe(Effect.option)
      const rows = yield* exposures.forProject(projectId).pipe(Effect.orElseSucceed(() => []))
      const entries = Option.isSome(project) ? entriesFor(project.value, rows) : []
      yield* hub.emit(exposureChanged(projectId, entries))
      return entries
    })

  const emitAllLanProjects: Effect.Effect<void> = Effect.gen(function* () {
    const rows = yield* exposures.listAll().pipe(Effect.orElseSucceed(() => []))
    const lanIds = [...new Set(rows.filter((r) => r.kind === "lan" && r.enabled).map((r) => r.projectId))]
    yield* push
    yield* Effect.forEach(lanIds, emitFor, { discard: true })
  })

  // ——— reconcile: store rows re-derived from the catalog, then project ———

  const reconcileInner = (projectId: ProjectId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const project = yield* projects.get(projectId).pipe(Effect.option)
      const port = Option.isSome(project) ? primaryPort(project.value) : undefined

      if (Option.isNone(project) || port === undefined) {
        // Gone or portless: rows cascade on delete; clear them explicitly for
        // the port-removed case, drop the mDNS advert, prune the routes.
        yield* exposures.removeKind(projectId, "stable_url").pipe(Effect.ignore)
        yield* exposures.removeKind(projectId, "lan").pipe(Effect.ignore)
        yield* mdns.withdraw(projectId)
        yield* push
        yield* hub.emit(exposureChanged(projectId, []))
        return
      }

      const slug = slugify(project.value.name)

      // The project's own answer, not the reconciler's assumption. A project
      // that declined its hostname loses the ROW as well as the route: a
      // disabled row left behind would still be reported in the snapshot, and a
      // client drawing "stable_url, off" beside a project that opted out is
      // offering a switch the user already threw.
      //
      // LAN is untouched here. It is a separate switch over a separate row, and
      // a project can legitimately want to be reachable on the network without
      // a loopback hostname.
      if (project.value.stableUrl === false) {
        yield* exposures.removeKind(projectId, "stable_url").pipe(Effect.ignore)
      } else {
        yield* exposures
          .upsert({
            projectId,
            kind: "stable_url",
            enabled: true,
            hostname: `${slug}.localhost`
          })
          .pipe(Effect.ignore)
      }

      // A rename moves the hostname: refresh the lan row + advert if present.
      const rows = yield* exposures.forProject(projectId).pipe(Effect.orElseSucceed(() => []))
      const lanRow = rows.find((r) => r.kind === "lan" && r.enabled)
      if (lanRow) {
        const hostname = `${slug}.${config.mdnsDomain}`
        if (lanRow.hostname !== hostname) {
          yield* exposures
            .upsert({ ...lanRow, hostname })
            .pipe(Effect.ignore)
        }
        yield* mdns.advertise(projectId, hostname)
      }

      yield* push
      yield* emitFor(projectId).pipe(Effect.asVoid)
    })

  const reconcile: ExposureShape["reconcile"] = (projectId) =>
    sem.withPermits(1)(reconcileInner(projectId))

  // ——— lan toggle ———

  /** A free wildcard port for a project's LAN listener, or undefined if the scan
   *  span is exhausted.
   *
   *  Probed, not counted: `Math.max(used) + 1` assumed every port above the
   *  highest allocation was ours to take. Anything else on the machine holding
   *  it made the next `POST /load` fail as a whole — Caddy validates listeners
   *  atomically — so one unlucky port took every project's routes down, not
   *  just this project's share. Probing also lets a released port be reused
   *  instead of climbing away from the base forever. */
  const allocateLanPort = Effect.gen(function* () {
    const rows = yield* exposures.listAll().pipe(Effect.orElseSucceed(() => []))
    const used = rows
      .map((r) => r.config?.["lanPort"])
      .filter((p): p is number => typeof p === "number")
    // Caddy's own two ports are excluded explicitly. The wildcard probe would
    // not catch them: they are held on loopback only, so 0.0.0.0 binds beside
    // them cleanly — and then Caddy is asked to listen twice on one port.
    return yield* selectWildcardPort(config.lanPortBase, {
      exclude: [...used, httpPort, opts.adminPort]
    })
  })

  const lanSet: ExposureShape["lanSet"] = (id, enabled) =>
    sem.withPermits(1)(
      Effect.gen(function* () {
        if (!available) {
          return yield* Effect.fail(
            new CaddyUnavailable({
              reason: Option.isNone(binary) ? "binary_missing" : "port_unavailable",
              message: unusableReason ?? "caddy unusable"
            })
          )
        }
        const project = yield* projects.get(id).pipe(
          Effect.mapError(
            (e) =>
              new ValidationError({
                message: e._tag === "NotFound" ? `project '${id}' not found` : String(e)
              })
          )
        )
        const port = primaryPort(project)
        if (port === undefined) {
          return yield* Effect.fail(
            new ValidationError({
              field: "ports",
              message: "declare a port before sharing — there is nothing to route to"
            })
          )
        }

        const slug = slugify(project.name)
        if (enabled) {
          const existing = (yield* exposures.forProject(id).pipe(Effect.orElseSucceed(() => []))).find(
            (r) => r.kind === "lan"
          )
          // An existing allocation is reused as-is — the published URL carries
          // the port, so re-picking one would silently invalidate whatever the
          // user already copied or scanned.
          const allocated =
            typeof existing?.config?.["lanPort"] === "number"
              ? (existing.config["lanPort"] as number)
              : yield* allocateLanPort
          if (allocated === undefined) {
            return yield* Effect.fail(
              new CaddyUnavailable({
                reason: "port_unavailable",
                message: `no free port for a LAN listener near ${config.lanPortBase} — free one up or set a different base`
              })
            )
          }
          const lanPort = allocated
          yield* exposures
            .upsert({
              projectId: id,
              kind: "lan",
              enabled: true,
              hostname: `${slug}.${config.mdnsDomain}`,
              config: { lanPort }
            })
            .pipe(Effect.orDieWith((e) => new Error(String(e.cause))))
          yield* mdns.advertise(id, `${slug}.${config.mdnsDomain}`)
        } else {
          yield* exposures
            .upsert({ projectId: id, kind: "lan", enabled: false })
            .pipe(Effect.orDieWith((e) => new Error(String(e.cause))))
          yield* mdns.withdraw(id)
        }

        yield* push
        const entries = yield* emitFor(id)
        return { entries }
      })
    )

  // ——— snapshot ———

  const snapshot: ExposureShape["snapshot"] = () =>
    Effect.gen(function* () {
      const all = yield* projects.list().pipe(Effect.orElseSucceed(() => []))
      const rows = yield* exposures.listAll().pipe(Effect.orElseSucceed(() => []))
      const perProject: Array<ProjectExposures> = []
      for (const p of all) {
        const entries = entriesFor(
          p,
          rows.filter((r) => r.projectId === p.id)
        )
        if (entries.length > 0) perProject.push({ projectId: p.id, entries })
      }
      const ip = mdns.currentIp()
      return {
        caddy: {
          available,
          running: running(),
          httpPort,
          ...(ip !== undefined ? { lanIp: ip } : {})
        },
        projects: perProject
      }
    })

  // ——— boot reconcile + catalog subscription ———

  // Restore mDNS adverts for rows that were enabled when the engine last ran,
  // then derive stable rows for any project added while a pre-exposure engine
  // was running. superviseCaddy already pushed the config on spawn.
  const bootRows = yield* exposures.listAll().pipe(Effect.orElseSucceed(() => []))
  const bootProjects = yield* projects.list().pipe(Effect.orElseSucceed(() => []))
  for (const row of bootRows) {
    if (row.kind === "lan" && row.enabled && row.hostname !== undefined) {
      yield* mdns.advertise(row.projectId, row.hostname)
    }
  }
  yield* Effect.forEach(bootProjects, (p) => reconcileInner(p.id), { discard: true }).pipe(
    sem.withPermits(1)
  )

  yield* hub.subscribe(
    (event) =>
      event.type === "catalog_changed" ? reconcile(event.projectId) : Effect.void,
    {}
  )

  return Exposure.of({ snapshot, lanSet, reconcile })
})

export const ExposureLive = Layer.scoped(Exposure, make)
