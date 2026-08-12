import { Context, Effect, Layer, Option } from "effect"
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
import { awaitPortBound } from "../supervisor/supervisor.probe.js"
import {
  desiredConfig,
  findCaddyBinary,
  makeAdmin,
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
//   LAN share toggled on     → `lan` row: <slug>.<domain> via mDNS, a dedicated
//                              0.0.0.0 listener on an allocated port, and the
//                              main listener flips loopback → 0.0.0.0
//   port removed / project gone → rows and routes go with it
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

  const opts = {
    adminPort: config.caddyAdminPort,
    httpPort: config.caddyHttpPort,
    mdnsDomain: config.mdnsDomain
  }

  // ——— provider boot (degrades cleanly when caddy is absent) ———

  const binary = yield* findCaddyBinary().pipe(Effect.option)
  const available = Option.isSome(binary)

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
        ...(typeof lanPort === "number" ? { lan: { lanPort } } : {})
      })
    }
    return specs
  })

  const desired = () => specsFromStore.pipe(Effect.map((specs) => desiredConfig(specs, opts)))

  let child: CaddyChild | undefined
  if (Option.isSome(binary)) {
    yield* writeBootstrap(CADDY_BOOTSTRAP_PATH, config.caddyAdminPort)
    child = yield* superviseCaddy({
      binary: binary.value,
      bootstrapPath: CADDY_BOOTSTRAP_PATH,
      adminPort: config.caddyAdminPort,
      desired,
      awaitReady: awaitPortBound(config.caddyAdminPort, 10_000),
      onExit: (code) => Effect.logWarning(`exposure: caddy exited (code ${code ?? "?"}) — respawning`)
    })
    yield* Effect.logInfo(
      `exposure: caddy up (http :${config.caddyHttpPort}, admin :${config.caddyAdminPort})`
    )
  } else {
    yield* Effect.logWarning(
      "exposure: caddy binary not found (brew install caddy) — stable URLs unavailable"
    )
  }

  const admin = makeAdmin(config.caddyAdminPort)
  const running = () => child?.isRunning() ?? false

  /** Push the full desired config — graceful in-process swap, never a restart. */
  const push = available
    ? desired().pipe(
        Effect.flatMap((cfg) => admin.load(cfg)),
        Effect.tapError((e) =>
          Effect.logWarning(`exposure: config push failed: ${e.detail ?? e.path}`)
        ),
        Effect.ignore
      )
    : Effect.void

  // ——— entry derivation (pure over store rows + provider state) ———

  const entriesFor = (project: Project, rows: ReadonlyArray<ExposureRecord>): Array<ExposureEntry> => {
    const port = primaryPort(project)
    if (port === undefined) return []
    const slug = slugify(project.name)
    const caddyState = !available ? "unavailable" : running() ? "active" : "error"
    const caddyMessage = !available
      ? "caddy not installed — brew install caddy"
      : running()
        ? undefined
        : "caddy not running"

    const entries: Array<ExposureEntry> = [
      {
        kind: "stable_url",
        url: `http://${slug}.localhost:${config.caddyHttpPort}`,
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
      entries.push({
        kind: "lan",
        url: `http://${slug}.${config.mdnsDomain}:${config.caddyHttpPort}`,
        enabled: true,
        state: lanState,
        ...(lanMessage !== undefined ? { message: lanMessage } : {})
      })
      const lanPort = lanRow.config?.["lanPort"]
      if (typeof lanPort === "number" && ip !== undefined) {
        entries.push({
          kind: "lan",
          url: `http://${ip}:${lanPort}`,
          enabled: true,
          state: lanState,
          ...(lanMessage !== undefined ? { message: lanMessage } : {})
        })
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
      yield* exposures
        .upsert({
          projectId,
          kind: "stable_url",
          enabled: true,
          hostname: `${slug}.localhost`
        })
        .pipe(Effect.ignore)

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

  const allocateLanPort = Effect.gen(function* () {
    const rows = yield* exposures.listAll().pipe(Effect.orElseSucceed(() => []))
    const used = rows
      .map((r) => r.config?.["lanPort"])
      .filter((p): p is number => typeof p === "number")
    return used.length === 0 ? config.lanPortBase : Math.max(...used) + 1
  })

  const lanSet: ExposureShape["lanSet"] = (id, enabled) =>
    sem.withPermits(1)(
      Effect.gen(function* () {
        if (!available) {
          return yield* Effect.fail(
            new CaddyUnavailable({
              reason: "binary_missing",
              message: "caddy not installed — brew install caddy"
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
          const lanPort =
            typeof existing?.config?.["lanPort"] === "number"
              ? (existing.config["lanPort"] as number)
              : yield* allocateLanPort
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
          httpPort: config.caddyHttpPort,
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
