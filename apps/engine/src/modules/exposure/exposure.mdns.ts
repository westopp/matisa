import { Duration, Effect, type Scope } from "effect"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import * as os from "node:os"
import type { ProjectId } from "@matisa/core"
import { LAN_IP_POLL_MS } from "../../config/config.constants.js"

// ────────────────────────────────────────────────────────────────────────────
// mDNS provider — same-network hostnames via `dns-sd -P` proxy records, one
// child per LAN-shared project. Port of the old Swift MDNSService:
//
// Why `dns-sd -P` rather than a Bonjour service registration: NetService-style
// records advertise typed services (_http._tcp) that only Bonjour *browsers*
// find. What we need is the OS answering `<slug>.matisa.local` to a phone's
// plain getaddrinfo — `-P` registers a proxy hostname mDNSResponder resolves
// for exactly that.
//
// The LAN IP watcher replaces NWPathMonitor with an os.networkInterfaces()
// poll: on IP change every child is killed and re-spawned against the new
// address; on IP loss children die but their hostnames are retained so an
// interface coming back re-advertises automatically.
// ────────────────────────────────────────────────────────────────────────────

/** Primary non-loopback IPv4, preferring en0-style interfaces; undefined when
 * no LAN interface is up. */
export const primaryLanIPv4 = (): string | undefined => {
  const ifaces = os.networkInterfaces()
  const candidates: Array<{ name: string; address: string }> = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) candidates.push({ name, address: a.address })
    }
  }
  if (candidates.length === 0) return undefined
  // en0/en1 (Wi-Fi / wired) beat utun/bridge/vpn interfaces.
  const en = candidates.find((c) => /^en\d/.test(c.name))
  return (en ?? candidates[0])?.address
}

interface Advert {
  readonly hostname: string
  child?: ChildProcess
}

export interface MdnsPublisher {
  /** Start (or restart) advertising `hostname` for a project. */
  readonly advertise: (projectId: ProjectId, hostname: string) => Effect.Effect<void>
  /** Stop advertising and forget the hostname. */
  readonly withdraw: (projectId: ProjectId) => Effect.Effect<void>
  readonly currentIp: () => string | undefined
  /** Advertised hostname per project (empty when not advertising). */
  readonly active: () => ReadonlyMap<ProjectId, string>
}

const findDnsSd = (): Effect.Effect<string | undefined> =>
  Effect.async<string | undefined>((resume) => {
    execFile("which", ["dns-sd"], { timeout: 2_000 }, (err, stdout) => {
      resume(Effect.succeed(err ? "/usr/bin/dns-sd" : stdout.trim() || "/usr/bin/dns-sd"))
    })
  })

/** Build the publisher and fork the IP watcher onto the caller's Scope.
 * `onIpChanged` fires after children have been re-spawned (or torn down on IP
 * loss) so the owner can refresh URLs / re-emit events. */
export const makeMdnsPublisher = (
  onIpChanged: (ip: string | undefined) => Effect.Effect<void>
): Effect.Effect<MdnsPublisher, never, Scope.Scope> =>
  Effect.gen(function* () {
    const adverts = new Map<ProjectId, Advert>()
    let ip = primaryLanIPv4()
    let stopping = false
    const dnsSd = yield* findDnsSd()

    const kill = (advert: Advert) => {
      try {
        advert.child?.kill("SIGTERM")
      } catch {
        /* already gone */
      }
      advert.child = undefined
    }

    const spawnAdvert = (advert: Advert, currentIp: string) => {
      // `dns-sd -P <leaf> <type> <domain> <port> <hostname.> <ip>` — proxy mode
      // registers a hostname mDNSResponder answers for plain DNS lookups. Type
      // and port are required args but irrelevant to hostname resolution.
      const leaf = advert.hostname.replace(/\.local$/, "")
      const child = spawn(
        dnsSd ?? "dns-sd",
        ["-P", leaf, "_http._tcp", "local", "80", advert.hostname, currentIp],
        { stdio: ["ignore", "ignore", "ignore"] }
      )
      advert.child = child
    }

    const advertise: MdnsPublisher["advertise"] = (projectId, hostname) =>
      Effect.sync(() => {
        const existing = adverts.get(projectId)
        if (existing) kill(existing)
        const advert: Advert = { hostname }
        adverts.set(projectId, advert)
        if (ip !== undefined) spawnAdvert(advert, ip)
      })

    const withdraw: MdnsPublisher["withdraw"] = (projectId) =>
      Effect.sync(() => {
        const advert = adverts.get(projectId)
        if (advert) kill(advert)
        adverts.delete(projectId)
      })

    const refresh: Effect.Effect<void> = Effect.gen(function* () {
      const next = primaryLanIPv4()
      if (next === ip) return
      ip = next
      yield* Effect.sync(() => {
        for (const advert of adverts.values()) {
          kill(advert)
          if (next !== undefined) spawnAdvert(advert, next)
        }
      })
      yield* onIpChanged(next)
    })

    const watcher: Effect.Effect<void> = Effect.gen(function* () {
      while (!stopping) {
        yield* Effect.sleep(Duration.millis(LAN_IP_POLL_MS))
        if (stopping) return
        yield* refresh
      }
    })

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopping = true
        for (const advert of adverts.values()) kill(advert)
        adverts.clear()
      })
    )
    yield* Effect.forkScoped(watcher)

    return {
      advertise,
      withdraw,
      currentIp: () => ip,
      active: () =>
        new Map(
          [...adverts.entries()].map(([id, advert]) => [id, advert.hostname] as const)
        )
    }
  })
