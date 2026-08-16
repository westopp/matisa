import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { join } from "node:path"
import { engineLogPath, ensureEngine } from "./engine.js"

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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The engine is a shared daemon, not our child — quitting the app leaves it
// (and the user's supervised processes) running.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
