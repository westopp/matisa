// Platform path + protocol constants. Pure — no Effect. The AppConfig service
// reads env overrides on top of these defaults and validates the result.

import { homedir } from "node:os"
import { join } from "node:path"

/** Where all engine state lives (socket, db, log, secrets). MATISA_ROOT
 * relocates the whole root at once; the per-file env overrides in AppConfig
 * still win over it individually. */
export const MATISA_ROOT = process.env.MATISA_ROOT ?? join(homedir(), ".matisa")

export const DEFAULT_SOCKET_PATH = `${MATISA_ROOT}/engine.sock`
export const DEFAULT_DB_PATH = `${MATISA_ROOT}/matisa.db`
export const DEFAULT_LOG_PATH = `${MATISA_ROOT}/engine.log`
/** File-backed keychain stub location (dev only). */
export const DEFAULT_SECRETS_PATH = `${MATISA_ROOT}/secrets.json`

/** PREFERRED Caddy admin API port (loopback-only; the exposure module drives it
 * live). 2019 is also the stock default of any user-installed caddy, so this is
 * a starting point for the probe in exposure.caddy, never an assumption. */
export const CADDY_ADMIN_PORT = 2019

/** PREFERRED port for the single loopback HTTP listener every stable hostname
 * routes through (http://<slug>.localhost:<port>). High port — no privileged
 * bind. Like the admin port it is probed first and stepped up if taken; the
 * port actually in use is reported as CaddyStatus.httpPort. */
export const CADDY_HTTP_PORT = 7777

/** First port of the per-project dedicated LAN listeners — the mDNS-free
 * fallback address (http://<lan-ip>:<allocated>). Allocated sequentially. */
export const LAN_PORT_BASE = 7801

/** mDNS domain for same-network hostnames (<slug>.matisa.local). */
export const MDNS_DOMAIN = "matisa.local"

/** Poll interval for the primary-LAN-IPv4 watcher (no NWPathMonitor on Node). */
export const LAN_IP_POLL_MS = 5000

/** Bootstrap config Caddy is spawned with (admin endpoint only; routes are
 * pushed over the admin API right after — never resumed from disk). */
export const CADDY_BOOTSTRAP_PATH = `${MATISA_ROOT}/caddy.bootstrap.json`

/** Loopback port for the WebSocket bridge that serves the same JSON-RPC surface
 * as the unix socket. Browsers cannot open a UDS, so the GUI speaks this. */
export const DEFAULT_WS_PORT = 4127

/** Hard cap on a single NDJSON frame (bytes) before the connection is faulted. */
export const MAX_FRAME_BYTES = 1024 * 1024

/** Engine version reported by engine.status.
 *
 * Baked in by the engine's esbuild `define` from the product version in
 * apps/shell/package.json — NOT read from the environment at run time, which is
 * why the substitution has to happen at build time. The value matters because
 * the desktop client compares it against the shell's own version: a daemon left
 * running by a previous build answers on the same port, and this string is the
 * only way to tell that it did. Unbuilt (tsx, tests) it reads 0.0.0-dev. */
export const ENGINE_VERSION = process.env.MATISA_VERSION ?? "0.0.0-dev"

/** Durable-queue retention: keep the newest N events; older rows are pruned at
 * boot and every few hours. Clients resuming from a pruned cursor restart at
 * the retention floor. */
export const EVENTS_KEEP_LAST = 20_000
export const EVENTS_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Terminal geometry for supervised run sessions (clients resize via pty.resize). */
export const RUN_PTY_COLS = 120
export const RUN_PTY_ROWS = 32

/** Per-session scrollback ring cap (base64 bytes) replayed on pty.attach. */
export const SCROLLBACK_MAX_BYTES = 256 * 1024

/** How long a project may sit in `starting` before the runner faults it. */
export const START_TIMEOUT_MS = 10_000
/** How long to wait for a child to exit after SIGTERM before SIGKILL. */
export const STOP_TIMEOUT_MS = 8_000
/** After SIGKILL, how long to wait for the REAPED exit before giving up on the
 * wait entirely. SIGKILL cannot be caught, so overshooting this means the exit
 * notification itself was lost — waiting longer would only wedge the caller. */
export const REAP_GRACE_MS = 2_000

/** Grace passed to `docker stop`/`compose down` (seconds) before the daemon
 * kills the container itself. Kept below the CLI timeouts so the daemon's own
 * escalation always fires first. */
export const DOCKER_STOP_GRACE_S = 10

/** A shell session (`sh:`) nobody has been attached to for this long is
 * unreachable — no client is coming back for it — and gets reaped. Command
 * (`cmd:`) and supervised (`run:`) sessions are NEVER reaped: they are doing
 * real work whether or not a terminal is pointed at them. */
export const SHELL_IDLE_REAP_MS = 15 * 60 * 1000
export const SHELL_REAP_INTERVAL_MS = 60_000

/** Boot orphan sweep: a spawn row whose pid is still alive is a leftover from an
 * engine that died without teardown. The pid is only killed when the process's
 * age agrees with the recorded start time — a reused pid belongs to someone
 * else, and killing it would be an act of vandalism. */
export const ORPHAN_PID_AGE_TOLERANCE_MS = 120_000
export const ORPHAN_TERM_GRACE_MS = 2_000

/** How long a discovery sweep stays fresh. Foreign processes emit no events, so
 * seeing them at all means probing — several lsof/docker shell-outs per sweep.
 * The TTL is what stops a polling client (or three) from paying that repeatedly
 * for an answer that cannot have changed much; `refresh: true` bypasses it when
 * a caller has just acted and needs the truth now. */
export const DISCOVERY_TTL_MS = 5_000

/** Grace given to an unmanaged process between SIGTERM and SIGKILL. Shorter
 * than a supervised stop: this is not our process, we have no drain contract
 * with it, and the user asked for it to be gone. */
export const DISCOVERY_TERM_GRACE_MS = 3_000
