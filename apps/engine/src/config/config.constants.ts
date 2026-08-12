// Platform path + protocol constants. Pure — no Effect. The AppConfig service
// reads env overrides on top of these defaults and validates the result.

export const MATISA_ROOT = "/Users/thulanekhumalo/Desktop/dev/tools/matisa/.matisa"

export const DEFAULT_SOCKET_PATH = `${MATISA_ROOT}/engine.sock`
export const DEFAULT_DB_PATH = `${MATISA_ROOT}/matisa.db`
export const DEFAULT_LOG_PATH = `${MATISA_ROOT}/engine.log`
/** File-backed keychain stub location (dev only). */
export const DEFAULT_SECRETS_PATH = `${MATISA_ROOT}/secrets.json`

/** Caddy admin API port (exposure module — stubbed). */
export const CADDY_ADMIN_PORT = 2019

/** Loopback port for the WebSocket bridge that serves the same JSON-RPC surface
 * as the unix socket. Browsers cannot open a UDS, so the GUI speaks this. */
export const DEFAULT_WS_PORT = 4127

/** Hard cap on a single NDJSON frame (bytes) before the connection is faulted. */
export const MAX_FRAME_BYTES = 1024 * 1024

/** Engine version reported by engine.status. */
export const ENGINE_VERSION = "0.1.0"

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
