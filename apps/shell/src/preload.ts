import { contextBridge, ipcRenderer } from "electron"

// The entire privileged surface. The renderer talks to the engine over
// WebSocket like any browser client — the bridge only carries what a browser
// genuinely cannot do.
contextBridge.exposeInMainWorld("matisa", {
  /** Open a URL in the system browser (renderer window.open is denied). */
  openExternal: (url: string): void => {
    void ipcRenderer.invoke("matisa:open-external", url)
  },
  platform: process.platform
})
