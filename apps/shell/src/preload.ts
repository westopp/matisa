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
  platform: process.platform
})
