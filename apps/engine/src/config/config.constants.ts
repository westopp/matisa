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

/** Hard cap on a single NDJSON frame (bytes) before the connection is faulted. */
export const MAX_FRAME_BYTES = 1024 * 1024

/** Restart backoff defaults (ms) — expo from `base`, capped at `cap`. */
export const DEFAULT_BACKOFF = { base: 500, cap: 30_000, maxAttempts: 5 } as const

/** Terminal geometry for supervised run sessions (clients resize via pty.resize). */
export const RUN_PTY_COLS = 120
export const RUN_PTY_ROWS = 32

/** Per-session scrollback ring cap (base64 bytes) replayed on pty.attach. */
export const SCROLLBACK_MAX_BYTES = 256 * 1024

/** How long a project may sit in `starting` before the runner faults it. */
export const START_TIMEOUT_MS = 10_000
/** How long to wait for a child to exit after SIGTERM before SIGKILL. */
export const STOP_TIMEOUT_MS = 8_000
