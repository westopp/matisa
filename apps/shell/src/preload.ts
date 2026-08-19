import { contextBridge, ipcRenderer } from "electron"

// The entire privileged surface. The renderer talks to the engine over
// WebSocket like any browser client — the bridge only carries what a browser
// genuinely cannot do.
contextBridge.exposeInMainWorld("matisa", {
  /** Open a URL in the system browser (renderer window.open is denied). */
  openExternal: (url: string): void => {
    void ipcRenderer.invoke("matisa:open-external", url)
  },
  /** Start the engine daemon if it is not already up; resolves true once its WS
   *  bridge accepts. The shell owns the engine's lifetime — it spawns one at
   *  launch — so recovering a dead engine is the shell's job to do and the
   *  renderer's only to ask for. Without this the window could see that the
   *  engine was gone and do nothing about it. */
  startEngine: (): Promise<boolean> => ipcRenderer.invoke("matisa:start-engine") as Promise<boolean>,
  /** Post a system notification. Resolves false where the OS will not show one
   *  — the caller falls back to its in-app toast rather than assuming. */
  notify: (title: string, body?: string): Promise<boolean> =>
    ipcRenderer.invoke("matisa:notify", { title, body }) as Promise<boolean>,
  /** Reveal the engine log in Finder — the one artefact that explains a failure
   *  the window could not. */
  revealEngineLog: (): void => {
    void ipcRenderer.invoke("matisa:reveal-engine-log")
  },
  /** The current update state, for a window that mounted after the download
   *  finished, and a subscription for one that did not. The unsubscribe is
   *  returned rather than exposing removeListener, so the renderer cannot
   *  detach a listener it did not add. */
  updateState: (): Promise<unknown> => ipcRenderer.invoke("matisa:update-state"),
  onUpdateState: (cb: (state: unknown) => void): (() => void) => {
    const listener = (_e: unknown, state: unknown): void => cb(state)
    ipcRenderer.on("matisa:update-state", listener)
    return () => ipcRenderer.removeListener("matisa:update-state", listener)
  },
  /** Replace the bundle and relaunch. THE ENGINE MUST ALREADY BE STOPPED — the
   *  caller owns that, because the caller is the side that speaks to it. This
   *  resolves with ok:false and a reason if the daemon is still listening, and
   *  never applies an update over a live one. */
  applyUpdate: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke("matisa:apply-update") as Promise<{ ok: boolean; reason?: string }>,
  /** Whether `matisa` is on PATH as a link to THIS bundle, and the command
   *  that would put it there. Asked again whenever the window regains focus, so
   *  a link made by hand in a terminal is noticed without a restart. */
  cliLink: (): Promise<unknown> => ipcRenderer.invoke("matisa:cli-link"),
  /** Create the link. May raise one macOS admin prompt — /usr/local/bin is
   *  root-owned on a Mac without Intel Homebrew — and reports a dismissed
   *  prompt as a cancellation rather than an error. */
  installCli: (): Promise<{ ok: boolean; path?: string; reason?: string; cancelled?: boolean }> =>
    ipcRenderer.invoke("matisa:install-cli") as Promise<{
      ok: boolean
      path?: string
      reason?: string
      cancelled?: boolean
    }>,
  /** This bundle's version. Compared against engine.status.version to catch a
   *  daemon left behind by a previous build. */
  version: ipcRenderer.sendSync("matisa:version") as string,
  platform: process.platform
})
