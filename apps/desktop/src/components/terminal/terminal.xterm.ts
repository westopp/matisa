import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"

// ────────────────────────────────────────────────────────────────────────────
// xterm plumbing kept out of React. The panes are REAL terminals — the engine
// spawns every supervised process and named command on a node-pty, so escape
// sequences, TTY detection and interactive prompts all work; a hand-parsed log
// view would silently drop all three.
// ────────────────────────────────────────────────────────────────────────────

/** Read a design token off the live document so the terminal follows the theme. */
const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export const terminalTheme = () => ({
  background: "rgba(0,0,0,0)",
  foreground: token("--text"),
  cursor: token("--accent"),
  cursorAccent: token("--card-bg"),
  selectionBackground: token("--accent-soft"),
  black: token("--text-faint"),
  red: token("--danger"),
  green: token("--success"),
  yellow: token("--warning"),
  blue: token("--info"),
  magenta: token("--magenta"),
  cyan: token("--info"),
  white: token("--text-muted"),
  brightBlack: token("--text-dim"),
  brightRed: token("--danger"),
  brightGreen: token("--success"),
  brightYellow: token("--warning"),
  brightBlue: token("--info"),
  brightMagenta: token("--magenta"),
  brightCyan: token("--info"),
  brightWhite: token("--text")
})

export interface XtermHandle {
  readonly term: Terminal
  readonly fit: FitAddon
  readonly dispose: () => void
}

export const createTerminal = (host: HTMLElement): XtermHandle => {
  const term = new Terminal({
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    fontFamily: token("--font-mono") || "monospace",
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 10_000,
    theme: terminalTheme()
  })

  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(host)

  return {
    term,
    fit,
    dispose: () => term.dispose()
  }
}

// Byte encoding lives in rpc.pty.ts, next to the attach registry that owns
// the wire framing in both directions.
