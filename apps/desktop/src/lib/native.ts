// The Electron preload bridge, when the renderer is inside the shell. Nothing
// here is required — every caller falls back to plain browser behaviour, so
// the same build runs in a tab (dev) and in the app.

/** What the shell reports about an update in flight. `idle` covers both "no
 *  update" and "this build has no feed to ask" — the window has nothing to say
 *  in either case, and no reason to tell them apart. */
export type UpdateState =
  | { readonly phase: "idle" }
  | { readonly phase: "downloading"; readonly version: string }
  | { readonly phase: "ready"; readonly version: string }
  | { readonly phase: "error"; readonly message: string }

/** Whether the `matisa` command is on PATH, as the window needs to render it.
 *  `supported: false` means there is nothing to offer — a browser tab, a dev
 *  build, or a platform this does not apply to — and the notice stays away. */
export interface CliLinkState {
  readonly supported: boolean
  readonly installed: boolean
  readonly path: string | null
  readonly command: string
}

export type CliInstallResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string; readonly cancelled?: boolean }

interface MatisaBridge {
  readonly openExternal: (url: string) => void
  readonly openFilePrivacySettings: () => void
  readonly startEngine: () => Promise<boolean>
  readonly notify: (title: string, body?: string) => Promise<boolean>
  readonly revealEngineLog: () => void
  readonly updateState: () => Promise<UpdateState>
  readonly onUpdateState: (cb: (state: UpdateState) => void) => () => void
  readonly applyUpdate: () => Promise<{ ok: boolean; reason?: string }>
  readonly cliLink: () => Promise<CliLinkState>
  readonly installCli: () => Promise<CliInstallResult>
  readonly windowTranslucent: () => Promise<boolean>
  readonly setWindowTranslucent: (value: boolean) => void
  readonly version: string
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

/** Open System Settings at Privacy & Security → Full Disk Access.
 *
 *  `false` outside the shell, where there is nothing to open — a browser tab
 *  cannot reach System Settings, and the caller needs to know that rather than
 *  render a button that does nothing. Full Disk Access cannot be requested by
 *  an app at all: there is no entitlement and no prompt for it, so taking the
 *  user to the pane is the entire available action. */
export const openFilePrivacySettings = (): boolean => {
  if (window.matisa === undefined) return false
  window.matisa.openFilePrivacySettings()
  return true
}

/** Ask the shell to start the engine it owns. `null` outside the shell, where
 *  there is nothing to ask — a browser tab cannot spawn a daemon, and the caller
 *  needs to know that rather than be handed a button that silently does
 *  nothing. */
export const startEngine = (): Promise<boolean> | null =>
  window.matisa === undefined ? null : window.matisa.startEngine()

/** This bundle's version — `null` in a browser tab, where there is no bundle.
 *  Compared against the engine's own version to catch a daemon that a previous
 *  build left running: the engine deliberately outlives the app, so after an
 *  update the old one is still listening on the same port and answers exactly
 *  like the right one. */
export const appVersion = (): string | null => window.matisa?.version ?? null

/** Reveal the engine log in Finder. No-op in a tab, where the file is not on
 *  the user's machine to reveal. */
export const revealEngineLog = (): void => window.matisa?.revealEngineLog()

/** Current update state plus a subscription; the unsubscribe is the return.
 *  Outside the shell nothing ever updates, so the callback is never called and
 *  the state stays idle. */
export const subscribeUpdateState = (cb: (state: UpdateState) => void): (() => void) => {
  const bridge = window.matisa
  if (bridge === undefined) {
    // A tab has no shell to ask, so the update strip could never be seen in the
    // browser — where the rest of this UI is built. `?update=ready&v=0.1.1`
    // stands one up. Dev only: stripped from the production bundle entirely, so
    // no query string a user is handed can put a fake update in front of them.
    if (import.meta.env.DEV) {
      const params = new URLSearchParams(window.location.search)
      const phase = params.get("update")
      const version = params.get("v") ?? "0.0.0"
      if (phase === "ready" || phase === "downloading") cb({ phase, version })
      else if (phase === "error") cb({ phase: "error", message: params.get("v") ?? "check failed" })
    }
    return () => {}
  }
  void bridge.updateState().then(cb)
  return bridge.onUpdateState(cb)
}

/** Swap the bundle and relaunch.
 *
 *  THE ENGINE MUST BE STOPPED FIRST and that is this side's job, because this is
 *  the side that speaks to it — the shell owns processes, not the protocol. The
 *  shell verifies the port actually closed and refuses to apply if it did not,
 *  so a failure here is a message to show, never a half-applied update. */
export const applyUpdate = async (): Promise<{ ok: boolean; reason?: string }> =>
  window.matisa === undefined
    ? { ok: false, reason: "Updates are only available in the desktop app." }
    : window.matisa.applyUpdate()

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

/** Whether `matisa` on PATH resolves to this bundle's wrapper.
 *
 *  Outside the shell there is no bundle to link and no PATH to link it into, so
 *  the answer is "nothing to offer" rather than "not installed" — the notice
 *  this feeds would otherwise be permanent furniture in the dev tab, where it
 *  could never be acted on. The command still comes back so the browser can be
 *  used to lay the banner out. */
export const cliLinkState = async (): Promise<CliLinkState> => {
  const bridge = window.matisa
  const command =
    'sudo ln -sfn "/Applications/Matisa.app/Contents/Resources/bin/matisa" /usr/local/bin/matisa'
  if (bridge !== undefined) return bridge.cliLink()
  // `?cli=missing` stands the notice up in the browser, where this UI is built.
  // Dev only, like the update strip's — nothing a user is handed can put a
  // button in front of them that would not work.
  const missing =
    import.meta.env.DEV && new URLSearchParams(window.location.search).get("cli") === "missing"
  return { supported: missing, installed: false, path: null, command }
}

/** Link the bundled CLI into /usr/local/bin. Raises at most one macOS admin
 *  prompt, and a dismissed prompt comes back as `cancelled` — the caller says
 *  nothing in that case, because the user already said it. */
export const installCli = async (): Promise<CliInstallResult> =>
  window.matisa === undefined
    ? { ok: false, reason: "The command can only be installed from the desktop app." }
    : window.matisa.installCli()

/** Whether the window is translucent. Always false outside the shell: a tab has
 *  no window of its own to fade, and the control that reads this is not offered
 *  there at all. */
export const windowTranslucent = async (): Promise<boolean> =>
  window.matisa === undefined ? false : window.matisa.windowTranslucent()

/** Turn translucency on or off. Nothing is returned and nothing is awaited —
 *  the shell composites the change and persists it, and the renderer paints
 *  nothing differently for it. */
export const setWindowTranslucent = (value: boolean): void => {
  window.matisa?.setWindowTranslucent(value)
}
