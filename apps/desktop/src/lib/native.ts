// The Electron preload bridge, when the renderer is inside the shell. Nothing
// here is required — every caller falls back to plain browser behaviour, so
// the same build runs in a tab (dev) and in the app.

interface MatisaBridge {
  readonly openExternal: (url: string) => void
  readonly platform: string
}

declare global {
  interface Window {
    matisa?: MatisaBridge
  }
}

export const inShell = (): boolean => window.matisa !== undefined

/** System browser inside the shell; a new tab outside it. */
export const openExternal = (url: string): void => {
  if (window.matisa !== undefined) window.matisa.openExternal(url)
  else window.open(url, "_blank", "noopener")
}
