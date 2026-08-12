import { Duration, Effect, type Scope } from "effect"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import type { ProjectId } from "@matisa/core"
import { CaddyAdminError, CaddyBinaryMissing } from "./exposure.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// Caddy provider — binary discovery, an engine-owned `caddy run` child, and a
// thin admin-API client. Config is NEVER a Caddyfile: the engine renders the
// desired JSON from the store and pushes it with a single graceful `POST /load`
// (in-process config swap; existing listeners kept, in-flight requests
// drained). Idempotent full-push beats per-route surgery: listener flips
// (loopback ↔ 0.0.0.0, dedicated LAN servers) are structural anyway, and the
// store stays the single source of truth — Caddy is a projection of it.
// Routes still carry "@id": "matisa:<projectId>" tags for inspectability.
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
}

const reverseProxy = (upstreamPort: number) => ({
  handler: "reverse_proxy",
  upstreams: [{ dial: `127.0.0.1:${upstreamPort}` }]
})

export const routeFor = (spec: RouteSpec, mdnsDomain: string): Record<string, unknown> => {
  const hosts = [`${spec.slug}.localhost`]
  if (spec.lan) hosts.push(`${spec.slug}.${mdnsDomain}`)
  return {
    "@id": `matisa:${spec.projectId}`,
    match: [{ host: hosts }],
    handle: [reverseProxy(spec.upstreamPort)]
  }
}

/** The full desired Caddy config. One `matisa` server carries every hostname
 * route; it binds loopback until any project is LAN-shared, then 0.0.0.0 so
 * phones can reach the mDNS hostnames. Each LAN-shared project additionally
 * gets a dedicated hostless listener (`matisa_lan_<id>` on its allocated
 * port) — the address that works where mDNS doesn't. */
export const desiredConfig = (
  specs: ReadonlyArray<RouteSpec>,
  opts: DesiredConfigOpts
): Record<string, unknown> => {
  const anyLan = specs.some((s) => s.lan !== undefined)
  const servers: Record<string, unknown> = {
    matisa: {
      listen: [`${anyLan ? "0.0.0.0" : "127.0.0.1"}:${opts.httpPort}`],
      automatic_https: { disable: true },
      routes: [
        ...specs.map((s) => routeFor(s, opts.mdnsDomain)),
        // Unmatched hostnames (stale URL after a rename, a typo) get an
        // explicit 404 instead of Caddy's default empty 200.
        {
          "@id": "matisa:fallback",
          handle: [
            {
              handler: "static_response",
              status_code: 404,
              body: "no project on this hostname — matisa\n"
            }
          ]
        }
      ]
    }
  }
  for (const s of specs) {
    if (!s.lan) continue
    servers[`matisa_lan_${s.projectId}`] = {
      listen: [`0.0.0.0:${s.lan.lanPort}`],
      automatic_https: { disable: true },
      routes: [{ "@id": `matisa:lan:${s.projectId}`, handle: [reverseProxy(s.upstreamPort)] }]
    }
  }
  return {
    admin: { listen: `127.0.0.1:${opts.adminPort}` },
    apps: { http: { servers } }
  }
}

/** Minimal config caddy is spawned with — admin endpoint only. The real routes
 * arrive via `POST /load` immediately after; never resumed from disk. */
export const bootstrapConfig = (adminPort: number): Record<string, unknown> => ({
  admin: { listen: `127.0.0.1:${adminPort}` },
  apps: { http: { servers: {} } }
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

// ——— admin-API client ———

export interface CaddyAdmin {
  readonly load: (config: Record<string, unknown>) => Effect.Effect<void, CaddyAdminError>
  readonly getConfig: () => Effect.Effect<unknown, CaddyAdminError>
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

export const makeAdmin = (adminPort: number): CaddyAdmin => ({
  load: (config) => request(adminPort, "POST", "/load", JSON.stringify(config)).pipe(Effect.asVoid),
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
})

// ——— child supervision ———

export interface CaddyChild {
  /** True while the child is alive. */
  readonly isRunning: () => boolean
}

/** Spawn `caddy run` and keep it alive for the lifetime of the caller's Scope:
 * unexpected exits respawn after a short delay, and every (re)spawn re-pushes
 * the config produced by `desired` so a killed caddy comes back with its
 * routes. Scope close stops the loop and SIGTERMs the child. */
export const superviseCaddy = (opts: {
  readonly binary: string
  readonly bootstrapPath: string
  readonly adminPort: number
  readonly desired: () => Effect.Effect<Record<string, unknown>>
  /** Readiness probe for the admin endpoint (awaitPortBound). */
  readonly awaitReady: Effect.Effect<boolean>
  readonly onExit: (code: number | null) => Effect.Effect<void>
}): Effect.Effect<CaddyChild, never, Scope.Scope> =>
  Effect.gen(function* () {
    let child: ChildProcess | undefined
    let stopping = false

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
      const config = yield* opts.desired()
      yield* makeAdmin(opts.adminPort).load(config)
    })

    const runLoop: Effect.Effect<void> = Effect.gen(function* () {
      while (!stopping) {
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

    return { isRunning: () => child !== undefined && child.exitCode === null && !stopping }
  })

/** Write the bootstrap config file caddy is spawned with. */
export const writeBootstrap = (path: string, adminPort: number): Effect.Effect<void> =>
  Effect.sync(() => {
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    fs.writeFileSync(path, JSON.stringify(bootstrapConfig(adminPort), null, 2))
  })
