import { Duration, Effect, type Scope } from "effect"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import * as net from "node:net"
import type { ProjectId } from "@matisa/core"
import { CaddyAdminError, CaddyBinaryMissing } from "./exposure.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// Caddy provider — binary discovery, an engine-owned `caddy run` child, and a
// thin admin-API client. Config is NEVER a Caddyfile: the engine renders the
// desired JSON from the store and pushes it with a single graceful `POST /load`
// (in-process config swap; existing listeners kept, in-flight requests
// drained). Idempotent full-push beats per-route surgery: dedicated LAN servers
// come and go structurally anyway, and the store stays the single source of
// truth — Caddy is a projection of it. Routes carry "@id": "matisa:<projectId>"
// tags for inspectability.
//
// This machine is not ours alone: a user-installed caddy (brew + launchd) is
// common and defaults to admin :2019. Two rules follow, and both are load-
// bearing rather than defensive garnish:
//
//   1. Ports are PROBED before use, in both loopback families. A bind test on
//      0.0.0.0 succeeds while someone else holds 127.0.0.1:<port> (BSD
//      SO_REUSEADDR), so a single wildcard probe proves nothing — that is
//      exactly how two caddies came to share :7777 and answer requests by
//      coin-flip depending on how `localhost` resolved.
//   2. Every admin call is gated on OWNERSHIP: the bootstrap config carries a
//      per-boot `@id` marker and the client refuses to POST /load to an
//      endpoint that does not report it back. Misconfiguring a stranger's web
//      server is not an acceptable failure mode, so ownership is established
//      positively instead of assumed from "the port answered".
// ────────────────────────────────────────────────────────────────────────────

// ——— pure builders (unit-tested, no IO) ———

/** Hostname-safe slug from a project name: lowercase, runs of non-alphanumerics
 * collapse to `-`, trimmed. Uniqueness rides on the unique project name. */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

export interface RouteSpec {
  readonly projectId: ProjectId
  readonly slug: string
  /** The declared upstream port (ports[0]) — Caddy dials 127.0.0.1:<port>. */
  readonly upstreamPort: number
  /** LAN share enabled → hostname on the mDNS domain joins the matcher and a
   * dedicated 0.0.0.0 listener is emitted on `lanPort`. */
  readonly lan?: { readonly lanPort: number }
}

export interface DesiredConfigOpts {
  readonly adminPort: number
  readonly httpPort: number
  readonly mdnsDomain: string
  /** Per-boot ownership marker — see `ownerId` / `makeAdmin`. */
  readonly ownerToken: string
}

const reverseProxy = (upstreamPort: number) => ({
  handler: "reverse_proxy",
  upstreams: [{ dial: `127.0.0.1:${upstreamPort}` }]
})

const staticResponse = (status: number, body: string) => ({
  handler: "static_response",
  status_code: status,
  body
})

/** The stable-URL route: `<slug>.localhost` only. The mDNS hostname is
 * deliberately NOT matched here — the shared server is loopback-bound, so a
 * `.local` name (which resolves to the LAN IP) could never arrive on it. */
export const routeFor = (spec: RouteSpec): Record<string, unknown> => ({
  "@id": `matisa:${spec.projectId}`,
  match: [{ host: [`${spec.slug}.localhost`] }],
  handle: [reverseProxy(spec.upstreamPort)]
})

/** Every hostname a project answers on, across both servers — the deny list of
 * a dedicated LAN listener is built from the OTHER projects' hostnames. */
const hostsOf = (spec: RouteSpec, mdnsDomain: string): ReadonlyArray<string> => [
  `${spec.slug}.localhost`,
  `${spec.slug}.${mdnsDomain}`
]

/** The full desired Caddy config.
 *
 * The shared `matisa` server carries every project's stable-URL route and is
 * bound to loopback ONLY — both families, so `<slug>.localhost` reaches us
 * whichever address the resolver picks. It is never rebound to 0.0.0.0: the
 * routes on it are separated by nothing but a Host matcher, so widening the
 * bind would publish every project to the LAN the moment ONE of them opted in
 * (anyone able to set a Host header gets in).
 *
 * LAN sharing is therefore carried entirely by per-project listeners
 * (`matisa_lan_<id>` on the project's allocated port): one 0.0.0.0 socket per
 * shared project, proxying to that project and refusing another project's
 * hostname explicitly rather than by accident. */
export const desiredConfig = (
  specs: ReadonlyArray<RouteSpec>,
  opts: DesiredConfigOpts
): Record<string, unknown> => {
  const servers: Record<string, unknown> = {
    matisa: {
      listen: [`127.0.0.1:${opts.httpPort}`, `[::1]:${opts.httpPort}`],
      automatic_https: { disable: true },
      routes: [
        ...specs.map(routeFor),
        // Unmatched hostnames (stale URL after a rename, a typo) get an
        // explicit 404 instead of Caddy's default empty 200.
        {
          "@id": "matisa:fallback",
          handle: [staticResponse(404, "no project on this hostname — matisa\n")]
        }
      ]
    }
  }
  for (const s of specs) {
    if (!s.lan) continue
    const foreignHosts = specs
      .filter((other) => other.projectId !== s.projectId)
      .flatMap((other) => hostsOf(other, opts.mdnsDomain))
    servers[`matisa_lan_${s.projectId}`] = {
      listen: [`0.0.0.0:${s.lan.lanPort}`],
      automatic_https: { disable: true },
      routes: [
        // A hostless catch-all is what makes `http://<lan-ip>:<port>` work at
        // all, but it would also serve THIS project to anyone asking for a
        // different project's hostname. Refuse those by name first, so the
        // scoping is a decision in the config rather than a 502 that happens
        // to look like a refusal.
        ...(foreignHosts.length === 0
          ? []
          : [
              {
                "@id": `matisa:lan:${s.projectId}:deny`,
                match: [{ host: foreignHosts }],
                handle: [
                  staticResponse(404, `this port serves only ${s.slug} — matisa\n`)
                ]
              }
            ]),
        { "@id": `matisa:lan:${s.projectId}`, handle: [reverseProxy(s.upstreamPort)] }
      ]
    }
  }
  return {
    admin: { listen: `127.0.0.1:${opts.adminPort}` },
    apps: { http: { "@id": ownerId(opts.ownerToken), servers } }
  }
}

/** The `@id` that proves a running caddy is the one this engine spawned. Caddy
 * keeps `@id` fields in the config it serves back and indexes them at
 * `/id/<id>`, which makes this a one-request ownership question. */
export const ownerId = (ownerToken: string): string => `matisa:owner:${ownerToken}`

/** Minimal config caddy is spawned with — admin endpoint plus the ownership
 * marker. The real routes arrive via `POST /load` immediately after; never
 * resumed from disk. */
export const bootstrapConfig = (
  adminPort: number,
  ownerToken: string
): Record<string, unknown> => ({
  admin: { listen: `127.0.0.1:${adminPort}` },
  apps: { http: { "@id": ownerId(ownerToken), servers: {} } }
})

// ——— binary discovery ———

const CADDY_FALLBACKS = ["/opt/homebrew/bin/caddy", "/usr/local/bin/caddy"]

/** `which caddy`, then the Homebrew prefixes. */
export const findCaddyBinary = (): Effect.Effect<string, CaddyBinaryMissing> =>
  Effect.async<string, CaddyBinaryMissing>((resume) => {
    execFile("which", ["caddy"], { timeout: 2_000 }, (err, stdout) => {
      const fromPath = err ? undefined : stdout.trim() || undefined
      const found = fromPath ?? CADDY_FALLBACKS.find((p) => fs.existsSync(p))
      resume(
        found !== undefined
          ? Effect.succeed(found)
          : Effect.fail(new CaddyBinaryMissing({ searched: ["PATH", ...CADDY_FALLBACKS] }))
      )
    })
  })

// ——— port selection ———

/** Loopback addresses a caddy of ours must own outright. Both families: the
 * resolver decides which one `localhost` becomes, and a port free in only one
 * of them is the split-brain this whole dance exists to prevent. */
const LOOPBACK_PROBE_HOSTS = ["127.0.0.1", "::1"] as const

/** How far above the configured port to look before giving up. Small on
 * purpose — a wide scan hides a real problem behind a surprising URL. */
export const PORT_SCAN_SPAN = 20

/** Can we bind `host:port` ourselves right now? A machine without IPv6 answers
 * "no such address" for ::1; that is not a collision, so it passes. Anything
 * else — EADDRINUSE, or EACCES on a privileged port — means unusable. */
const bindable = (port: number, host: string): Effect.Effect<boolean> =>
  Effect.async<boolean>((resume) => {
    const server = net.createServer()
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      resume(Effect.succeed(ok))
    }
    server.once("error", (err: NodeJS.ErrnoException) =>
      settle(err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL")
    )
    server.listen({ host, port, exclusive: true }, () => server.close(() => settle(true)))
    return Effect.sync(() => server.close())
  })

/** True when nothing else holds `port` on either loopback address. */
export const loopbackPortFree = (port: number): Effect.Effect<boolean> =>
  Effect.forEach(LOOPBACK_PROBE_HOSTS, (host) => bindable(port, host)).pipe(
    Effect.map((results) => results.every((ok) => ok))
  )

/** True when nothing holds `port` on the wildcard address — the exact bind a
 * per-project LAN listener performs. Distinct from `loopbackPortFree`: these
 * listeners are reachable from the network, so the address they actually take
 * is what has to be free. */
export const wildcardPortFree = (port: number): Effect.Effect<boolean> =>
  bindable(port, "0.0.0.0")

/** First free port at or above `preferred`, skipping `exclude`. Ascending and
 * deterministic so successive boots on an unchanged machine land on the same
 * port and published URLs stay stable; `undefined` when the whole span is
 * taken (the caller degrades to `unavailable` — never a failed boot). */
const selectPort = (
  free: (port: number) => Effect.Effect<boolean>,
  preferred: number,
  options: { readonly span?: number; readonly exclude?: ReadonlyArray<number> }
): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    const span = options.span ?? PORT_SCAN_SPAN
    const exclude = options.exclude ?? []
    for (let port = preferred; port < preferred + span; port++) {
      if (exclude.includes(port)) continue
      if (yield* free(port)) return port
    }
    return undefined
  })

export const selectLoopbackPort = (
  preferred: number,
  options: { readonly span?: number; readonly exclude?: ReadonlyArray<number> } = {}
): Effect.Effect<number | undefined> => selectPort(loopbackPortFree, preferred, options)

/** The LAN-listener counterpart. Probed rather than counted upward from the
 * last one used, because Caddy validates every listener in a `POST /load`
 * atomically: one occupied LAN port does not degrade that project, it rejects
 * the whole config and takes every other project's routes down with it. */
export const selectWildcardPort = (
  preferred: number,
  options: { readonly span?: number; readonly exclude?: ReadonlyArray<number> } = {}
): Effect.Effect<number | undefined> => selectPort(wildcardPortFree, preferred, options)

// ——— admin-API client ———

/** `foreign` is the only verdict that means "somebody else's caddy is on our
 * admin port" — `unreachable` is just a caddy that has not come up yet (or has
 * died), which is a retry, not a betrayal. Conflating the two would strand the
 * supervisor after any ordinary start failure. */
export type AdminOwnership = "ours" | "foreign" | "unreachable"

export interface CaddyAdmin {
  /** Push the full config — refuses unless the endpoint is provably ours. */
  readonly load: (config: Record<string, unknown>) => Effect.Effect<void, CaddyAdminError>
  readonly getConfig: () => Effect.Effect<unknown, CaddyAdminError>
  /** Does the caddy on this admin port report our ownership marker? */
  readonly ownership: () => Effect.Effect<AdminOwnership>
}

const request = (
  adminPort: number,
  method: string,
  path: string,
  body?: string
): Effect.Effect<string, CaddyAdminError> =>
  Effect.async<string, CaddyAdminError>((resume) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: adminPort,
        method,
        path,
        timeout: 5_000,
        headers: body === undefined ? {} : { "content-type": "application/json" }
      },
      (res) => {
        let data = ""
        res.on("data", (c: Buffer) => (data += c.toString()))
        res.on("end", () => {
          const status = res.statusCode ?? 0
          if (status >= 200 && status < 300) resume(Effect.succeed(data))
          else
            resume(
              Effect.fail(
                new CaddyAdminError({ method, path, status, detail: data.slice(0, 500) })
              )
            )
        })
      }
    )
    req.on("error", (err) =>
      resume(Effect.fail(new CaddyAdminError({ method, path, detail: err.message })))
    )
    req.on("timeout", () => {
      req.destroy()
      resume(Effect.fail(new CaddyAdminError({ method, path, detail: "timeout" })))
    })
    if (body !== undefined) req.write(body)
    req.end()
    return Effect.sync(() => req.destroy())
  })

/** Admin client bound to one endpoint AND one ownership marker. Every `load`
 * re-asks the ownership question first: the port was probed free before spawn,
 * but a caddy that died and let someone else take the port must not inherit our
 * config pushes. An extra loopback GET per push is nothing next to
 * reconfiguring a web server we do not own. */
export const makeAdmin = (adminPort: number, ownerToken: string): CaddyAdmin => {
  const marker = ownerId(ownerToken)
  const ownership = (): Effect.Effect<AdminOwnership> =>
    // `/id/<id>` 404s on a caddy that never saw our marker, and the returned
    // object is re-checked so a 200 from something that is not caddy at all
    // cannot pass for ownership. An HTTP status means SOMETHING is serving the
    // port; only a transport failure means nothing is there yet.
    request(adminPort, "GET", `/id/${marker}`).pipe(
      Effect.flatMap((raw) =>
        Effect.try(() =>
          (JSON.parse(raw) as { readonly ["@id"]?: unknown })["@id"] === marker
            ? ("ours" as const)
            : ("foreign" as const)
        ).pipe(Effect.orElseSucceed(() => "foreign" as const))
      ),
      Effect.catchAll((e) =>
        Effect.succeed(e.status === undefined ? ("unreachable" as const) : ("foreign" as const))
      )
    )
  return {
    ownership,
    load: (config) =>
      ownership().pipe(
        Effect.flatMap((verdict) =>
          verdict === "ours"
            ? request(adminPort, "POST", "/load", JSON.stringify(config)).pipe(Effect.asVoid)
            : Effect.fail(
                new CaddyAdminError({
                  method: "POST",
                  path: "/load",
                  detail:
                    verdict === "unreachable"
                      ? `admin :${adminPort} not answering yet`
                      : `admin :${adminPort} is not the caddy this engine spawned — refusing to configure it`
                })
              )
        )
      ),
    getConfig: () =>
      request(adminPort, "GET", "/config/").pipe(
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: () =>
              new CaddyAdminError({ method: "GET", path: "/config/", detail: "invalid JSON" })
          })
        )
      )
  }
}

// ——— child supervision ———

export interface CaddyChild {
  /** True while the child is alive. */
  readonly isRunning: () => boolean
  /** True once the admin endpoint has answered as ours AND taken a config. Only
   * then is an out-of-band `load` worth attempting: before it, the supervisor's
   * own post-readiness push is what delivers the routes. */
  readonly isReady: () => boolean
  /** Set when the admin endpoint on our port answered but is somebody else's
   * caddy: the supervisor gives up instead of respawning into a fight, and the
   * provider reports itself unusable. */
  readonly ownershipFault: () => string | undefined
}

/** Spawn `caddy run` and keep it alive for the lifetime of the caller's Scope:
 * unexpected exits respawn after a short delay, and every (re)spawn re-pushes
 * the config produced by `desired` so a killed caddy comes back with its
 * routes. Scope close stops the loop and SIGTERMs the child. */
export const superviseCaddy = (opts: {
  readonly binary: string
  readonly bootstrapPath: string
  readonly adminPort: number
  /** Ownership marker written into the bootstrap config. */
  readonly ownerToken: string
  readonly desired: () => Effect.Effect<Record<string, unknown>>
  /** Readiness probe for the admin endpoint (awaitPortBound). */
  readonly awaitReady: Effect.Effect<boolean>
  readonly onExit: (code: number | null) => Effect.Effect<void>
  readonly onForeignAdmin: (detail: string) => Effect.Effect<void>
}): Effect.Effect<CaddyChild, never, Scope.Scope> =>
  Effect.gen(function* () {
    let child: ChildProcess | undefined
    let stopping = false
    let ready = false
    let ownershipFault: string | undefined
    const admin = makeAdmin(opts.adminPort, opts.ownerToken)

    const spawnOnce: Effect.Effect<void, CaddyAdminError> = Effect.gen(function* () {
      yield* Effect.async<void>((resume) => {
        const c = spawn(opts.binary, ["run", "--config", opts.bootstrapPath], {
          stdio: ["ignore", "ignore", "ignore"]
        })
        child = c
        let settled = false
        const settle = () => {
          if (!settled) {
            settled = true
            resume(Effect.void)
          }
        }
        // If caddy dies instantly (admin port taken, bad config) the readiness
        // probe reports it; we only need the pid to exist to continue.
        c.on("spawn", settle)
        c.on("error", settle)
      })
      yield* opts.awaitReady
      // Ownership before configuration, always: if the endpoint that answered
      // belongs to another caddy (ours lost the bind race, or died and the port
      // was taken over), pushing would rewrite a stranger's web server.
      const verdict = yield* admin.ownership()
      if (verdict === "foreign") {
        ownershipFault = `admin :${opts.adminPort} is answered by a caddy this engine does not own`
        stopping = true
        try {
          child?.kill("SIGTERM")
        } catch {
          /* already gone */
        }
        return yield* opts.onForeignAdmin(ownershipFault)
      }
      const config = yield* opts.desired()
      yield* admin.load(config)
      ready = true
    })

    const runLoop: Effect.Effect<void> = Effect.gen(function* () {
      while (!stopping) {
        // A respawn starts from unready: the new child has no config until
        // spawnOnce pushes it, and an out-of-band load in that window would be
        // aimed at a caddy that is not listening yet.
        ready = false
        yield* spawnOnce.pipe(
          Effect.tapError((e) =>
            Effect.logWarning(`caddy config push failed: ${e.detail ?? e.path}`)
          ),
          Effect.ignore
        )
        const code = yield* Effect.async<number | null>((resume) => {
          const c = child
          if (!c || c.exitCode !== null) return resume(Effect.succeed(c?.exitCode ?? null))
          c.once("exit", (exitCode) => resume(Effect.succeed(exitCode)))
        })
        if (stopping) return
        yield* opts.onExit(code)
        yield* Effect.sleep(Duration.seconds(2))
      }
    })

    // Finalizers run in reverse registration order: the forked loop fiber is
    // interrupted first (its own scope finalizer), then this one reaps the
    // child so a respawn can't race the shutdown.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopping = true
        try {
          child?.kill("SIGTERM")
        } catch {
          /* already gone */
        }
      })
    )
    yield* Effect.forkScoped(runLoop)

    return {
      isRunning: () => child !== undefined && child.exitCode === null && !stopping,
      isReady: () => ready && child?.exitCode === null && !stopping,
      ownershipFault: () => ownershipFault
    }
  })

/** Write the bootstrap config file caddy is spawned with. */
export const writeBootstrap = (
  path: string,
  adminPort: number,
  ownerToken: string
): Effect.Effect<void> =>
  Effect.sync(() => {
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    fs.writeFileSync(path, JSON.stringify(bootstrapConfig(adminPort, ownerToken), null, 2))
  })
