import { spawn } from "node:child_process"
import { connect } from "node:net"
import { openSync } from "node:fs"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { app } from "electron"

// ────────────────────────────────────────────────────────────────────────────
// Acquire-or-start. The engine is a standalone daemon shared with the CLI —
// the shell never owns it, it only guarantees one is reachable before the
// window loads. Whoever connects first to an already-listening port wins;
// whoever loses a spawn race exits on EADDRINUSE and connects like everyone
// else. Quitting the app leaves the engine (and everything it supervises)
// running on purpose.
// ────────────────────────────────────────────────────────────────────────────

export const WS_PORT = Number(process.env.MATISA_WS_PORT ?? 4127)

/** Where all engine state lives — must agree with the engine's and CLI's own
 * MATISA_ROOT resolution so all three meet at the same socket. */
export const matisaRoot = (): string =>
  process.env.MATISA_ROOT ?? join(homedir(), ".matisa")

/** The bundled single-file engine. Packaged: shipped under resources/ next to
 * the natives it require()s. Dev: the sibling workspace's build output. */
const engineEntry = (): string =>
  process.env.MATISA_ENGINE_ENTRY ??
  (app.isPackaged
    ? join(process.resourcesPath, "engine", "engine.cjs")
    : join(__dirname, "..", "..", "engine", "dist", "engine.cjs"))

const portAccepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
    sock.setTimeout(1_000, () => done(false))
  })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const spawnEngine = (): void => {
  const root = matisaRoot()
  mkdirSync(root, { recursive: true })
  // The daemon outlives us, so its stdout goes to a file, not our pipe — a
  // dead pipe would SIGPIPE it long after the app quit.
  const log = openSync(join(root, "engine.log"), "a")
  const child = spawn(process.execPath, [engineEntry()], {
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      // Run the app's own binary as plain Node: one shipped runtime, one ABI,
      // natives rebuilt once for Electron and shared by app and daemon.
      ELECTRON_RUN_AS_NODE: "1",
      MATISA_ROOT: root,
      MATISA_SOCK: join(root, "engine.sock")
    }
  })
  child.unref()
}

/** True once the WS bridge accepts. Spawns at most once; the rest is waiting —
 * a raced second engine exits itself on EADDRINUSE. */
export const ensureEngine = async (): Promise<boolean> => {
  if (await portAccepts(WS_PORT)) return true
  spawnEngine()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await portAccepts(WS_PORT)) return true
    await sleep(250)
  }
  return false
}

/** True once nothing is listening on the bridge — i.e. the daemon is really
 *  gone, not merely asked to go.
 *
 *  Applying an update needs this. The daemon deliberately outlives the app, so
 *  a bundle swapped underneath a still-running engine leaves the NEW window
 *  talking to the OLD build's daemon — with the old handlers, the old schema
 *  expectations, and no way to notice. The renderer asks the engine to stop
 *  (it owns the protocol); this is the shell confirming that it did, before the
 *  bundle is replaced. Timing out is a refusal to update, not a warning: an
 *  update applied over a live daemon is the exact failure this exists to
 *  prevent. */
export const waitForEngineStop = async (timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portAccepts(WS_PORT))) return true
    await sleep(250)
  }
  return !(await portAccepts(WS_PORT))
}

// Referenced so a future "engine log" menu item knows where to look.
export const engineLogPath = (): string => join(matisaRoot(), "engine.log")
export const engineDir = (): string => dirname(engineEntry())
