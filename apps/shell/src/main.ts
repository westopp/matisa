import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron"
import { autoUpdater } from "electron-updater"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { engineLogPath, ensureEngine, waitForEngineStop } from "./engine.js"
import { cliLinkState, installCliLink } from "./cli-link.js"

// ────────────────────────────────────────────────────────────────────────────
// Electron main — a thin supervisor. It guarantees an engine is reachable,
// opens one window onto the renderer, and exposes exactly the affordances a
// browser tab could not (openExternal). All real communication stays on the
// WebSocket the renderer already speaks; main is not a message broker.
// ────────────────────────────────────────────────────────────────────────────

const DEV = process.env.MATISA_SHELL_DEV === "1"
const DEV_URL = "http://localhost:6110"

if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null

const createWindow = (): void => {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // The renderer draws its own chrome (it already has a titlebar row); the
    // real traffic lights sit inside it.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: "#101013",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once("ready-to-show", () => win?.show())
  win.on("closed", () => {
    win = null
  })

  // Anything the renderer window.opens or targets _blank goes to the system
  // browser; the shell never grows a second webContents.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url)
    return { action: "deny" }
  })

  if (DEV) {
    // Vite may still be booting; retry rather than show a dead window.
    const load = (): void => {
      win?.loadURL(DEV_URL).catch(() => setTimeout(load, 1_000))
    }
    load()
  } else {
    void win.loadFile(join(__dirname, "renderer", "index.html"))
  }
}

ipcMain.handle("matisa:open-external", (_e, url: unknown) => {
  if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
    void shell.openExternal(url)
  }
})

// Recovering a dead engine, asked for by the window's banner. Takes no
// arguments and can only ever start the one engine this app owns, so there is
// nothing here for a renderer to get wrong. ensureEngine is already idempotent —
// it returns immediately if the bridge accepts — so a user leaning on the button
// spawns nothing extra.
ipcMain.handle("matisa:start-engine", () => ensureEngine())

// A system notification, for events the renderer decided are worth interrupting
// over while the window does not have focus. The renderer owns that decision —
// it is the side that knows the user's preferences and whether it is focused —
// and this side owns the capability, because a renderer cannot post one.
//
// Clicking it brings the window forward. That is the entire point of raising it:
// a notification about a project you cannot then look at is a dead end. The body
// is passed through as text and never interpreted, so nothing an engine event
// carries can become markup or a link.
ipcMain.handle("matisa:notify", (_e, payload: unknown) => {
  if (!Notification.isSupported()) return false
  if (typeof payload !== "object" || payload === null) return false
  const { title, body } = payload as { title?: unknown; body?: unknown }
  if (typeof title !== "string" || title === "") return false

  const notification = new Notification({
    title,
    ...(typeof body === "string" ? { body } : {})
  })
  notification.on("click", () => {
    if (win === null) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  notification.show()
  return true
})

// ────────────────────────────────────────────────────────────────────────────
// Updates.
//
// electron-updater does the fetching; the interesting part is when the swap is
// allowed to happen. The engine is a shared daemon that deliberately survives
// this app quitting, so replacing the bundle on quit — autoInstallOnAppQuit,
// the default — would leave the next launch's window talking to the previous
// build's daemon, indefinitely. So: never install implicitly. The renderer
// stops the engine, the shell confirms the port is closed, and only then does
// the bundle get replaced.
//
// The user is asked because applying costs them something real: stopping the
// engine stops everything it supervises. An update that silently killed a
// running dev server would be worse than no update at all.
// ────────────────────────────────────────────────────────────────────────────

type UpdateState =
  | { readonly phase: "idle" }
  | { readonly phase: "downloading"; readonly version: string }
  | { readonly phase: "ready"; readonly version: string }
  | { readonly phase: "error"; readonly message: string }

let updateState: UpdateState = { phase: "idle" }

const setUpdateState = (next: UpdateState): void => {
  updateState = next
  win?.webContents.send("matisa:update-state", next)
}

// app-update.yml is written into the bundle only when a publish target was
// configured at build time. A local build has no feed, and checking would throw
// on every interval — absence is the signal that updates are not this build's
// concern. Unpackaged (dev) is the same story.
const updatesConfigured = (): boolean =>
  app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml"))

const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000

const initUpdates = (): void => {
  if (!updatesConfigured()) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on("update-available", (info) => {
    setUpdateState({ phase: "downloading", version: info.version })
  })
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState({ phase: "ready", version: info.version })
  })
  // A failed check is not worth interrupting anyone over — the feed being
  // briefly unreachable is ordinary. It is surfaced, quietly, because a tester
  // whose updates have silently stopped arriving needs some way to find out.
  autoUpdater.on("error", (err) => {
    setUpdateState({ phase: "error", message: err.message })
  })

  void autoUpdater.checkForUpdates().catch(() => undefined)
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined)
  }, CHECK_INTERVAL_MS)
}

ipcMain.handle("matisa:update-state", () => updateState)

// Applying. The renderer has already called engine.shutdown by the time this
// runs — it speaks the protocol, this side does not — so all that is left is to
// verify the daemon actually went, and refuse if it did not. Returning a reason
// rather than throwing keeps the renderer's failure path a message, not a
// stack trace.
ipcMain.handle("matisa:apply-update", async () => {
  if (updateState.phase !== "ready") {
    return { ok: false, reason: "No update has finished downloading." }
  }
  if (!(await waitForEngineStop())) {
    return {
      ok: false,
      reason:
        "The engine is still running — the update was not applied. Stop it and try again, or quit and reopen Matisa."
    }
  }
  // isForceRunAfter: the app is being relaunched into, not shut down. Without
  // it a macOS update quits to nothing and the user has to find the icon again.
  autoUpdater.quitAndInstall(false, true)
  return { ok: true }
})

// Synchronous because it is read once, during preload, to build the bridge —
// an async version would hand the renderer a promise for a constant.
ipcMain.on("matisa:version", (e) => {
  e.returnValue = app.getVersion()
})

// Whether `matisa` is on PATH, and putting it there. Read fresh on every call
// rather than cached at launch: the window asks again when it regains focus, so
// a user who ran the command in their own terminal sees the notice go away
// without restarting the app.
ipcMain.handle("matisa:cli-link", () => cliLinkState())
// Takes no arguments — the link's source and destination are both this
// module's, so there is nothing here a renderer could point somewhere else.
ipcMain.handle("matisa:install-cli", () => installCliLink())

// The engine log is the only artefact that explains a failure the UI could not.
// Revealing beats opening: the user may want to send the file, not read it.
ipcMain.handle("matisa:reveal-engine-log", () => {
  shell.showItemInFolder(engineLogPath())
})

app.on("second-instance", () => {
  if (win !== null) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  const up = await ensureEngine()
  if (!up) {
    // The window still opens — the renderer has its own reconnect loop and
    // shows its engine-offline state — but the user is told why it is empty.
    dialog.showErrorBox(
      "Matisa engine failed to start",
      `The background engine did not come up within 15s.\nSee ${engineLogPath()} for details.`
    )
  }
  createWindow()
  initUpdates()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The engine is a shared daemon, not our child — quitting the app leaves it
// (and the user's supervised processes) running.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
