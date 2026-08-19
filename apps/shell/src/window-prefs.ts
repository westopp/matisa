import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { matisaRoot } from "./engine.js"

// ────────────────────────────────────────────────────────────────────────────
// Preferences that belong to the WINDOW rather than to the installation.
//
// Not in the engine's settings document, which is where every other preference
// lives — and the reason is timing, not taxonomy. This has to be on the window
// before it is shown, and the engine may be starting, unreachable, or mid-
// restart at that moment. A window that opens opaque and then jumps to the
// user's setting a second later is worse than one that never had the setting,
// so this side keeps its own file and reads it synchronously.
//
// One small JSON file next to the engine's own state. No schema library and no
// migration story on purpose: every field is optional, anything unreadable
// falls back to the default, and a corrupt file costs the user their window
// preference — not their window.
// ────────────────────────────────────────────────────────────────────────────

interface WindowPrefs {
  /** Whether the window is translucent. A flag rather than a number: this is
   *  NSWindow alpha, which fades the whole window including its text, so it is
   *  only defensible at a value slight enough not to cost legibility. One
   *  well-chosen setting is the honest shape of that — a slider would invite
   *  the user down to a number where the app stops being readable. */
  readonly translucent: boolean
}

/** What "on" means. Enough that the desktop reads through and the window stops
 *  looking pasted onto the screen; not enough to touch contrast. Raising this
 *  past ~0.9 is where text starts paying for it. */
export const TRANSLUCENT_OPACITY = 0.95

const DEFAULTS: WindowPrefs = { translucent: false }

const prefsPath = (): string => join(matisaRoot(), "window.json")

/** The alpha the window should carry for a given preference. The mapping lives
 *  here, beside the constant, so main only ever passes the user's answer
 *  around and never a number it had to know how to pick. */
export const opacityFor = (translucent: boolean): number =>
  translucent ? TRANSLUCENT_OPACITY : 1

export const readWindowPrefs = (): WindowPrefs => {
  try {
    const raw: unknown = JSON.parse(readFileSync(prefsPath(), "utf8"))
    if (typeof raw !== "object" || raw === null) return DEFAULTS
    const { translucent } = raw as { translucent?: unknown }
    return { translucent: translucent === true }
  } catch {
    // Missing (first launch) and malformed are the same answer: the defaults.
    return DEFAULTS
  }
}

export const saveWindowPrefs = (patch: Partial<WindowPrefs>): void => {
  const next: WindowPrefs = { ...readWindowPrefs(), ...patch }
  try {
    mkdirSync(matisaRoot(), { recursive: true })
    writeFileSync(prefsPath(), `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    // A failed write costs the user their preference on the next launch and
    // nothing else — it is live for this session either way, and there is no
    // action for them to take, so it is not worth interrupting them over.
  }
}
