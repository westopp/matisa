// The Electron preload bridge, when the renderer is inside the shell. Nothing
// here is required — every caller falls back to plain browser behaviour, so
// the same build runs in a tab (dev) and in the app.

interface MatisaBridge {
  readonly openExternal: (url: string) => void
  readonly startEngine: () => Promise<boolean>
  readonly notify: (title: string, body?: string) => Promise<boolean>
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

/** Ask the shell to start the engine it owns. `null` outside the shell, where
 *  there is nothing to ask — a browser tab cannot spawn a daemon, and the caller
 *  needs to know that rather than be handed a button that silently does
 *  nothing. */
export const startEngine = (): Promise<boolean> | null =>
  window.matisa === undefined ? null : window.matisa.startEngine()

/** A system notification through the shell, or the browser's own where the page
 *  has been granted permission. Resolves false when neither is available, which
 *  is the caller's cue to keep the news in-app instead of dropping it.
 *
 *  The browser path is best-effort on purpose: it exists so the dev build in a
 *  tab behaves like the packaged app, and it never PROMPTS — a permission
 *  dialog raised by a background crash is not something the user asked for. */
export const notify = async (title: string, body?: string): Promise<boolean> => {
  if (window.matisa !== undefined) return window.matisa.notify(title, body)
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false
  try {
    // eslint-disable-next-line no-new
    new Notification(title, body === undefined ? {} : { body })
    return true
  } catch {
    return false
  }
}
