import type { SessionId } from "@matisa/core"
import { reattachSession, resizeSession, sendInput, subscribeSession } from "~/rpc/rpc.pty"
import { useTerminals } from "~/store/store.terminals"
import { createTerminal, type XtermHandle } from "./terminal.xterm"

// ────────────────────────────────────────────────────────────────────────────
// Persistent xterm surfaces.
//
// A terminal's scrollback lives in the xterm instance, and `pty.attach` replays
// history exactly once per connection — the engine has no "replay again". So
// every unmount of a pane component is data loss, and React reconciles the split
// tree by POSITION: docking a pane elsewhere turns a TerminalPane slot into a
// SplitContainer slot, which unmounts the pane and takes its scrollback with it.
//
// The fix is to stop letting React own the terminal. Each pane gets one surface
// element built here, `term.open()`d once, and REPARENTED into whichever slot
// the pane currently renders into. A move becomes a single appendChild: same
// element, same instance, same scrollback. The component owns the chrome only.
//
// Safe because no canvas/WebGL renderer is loaded (see terminal.xterm.ts) — the
// DOM renderer survives reparenting intact. Loading addon-webgl would put a
// context loss on this path and force a refit-and-clear after every move.
// ────────────────────────────────────────────────────────────────────────────

/** The mounted pane's slice of view state, swapped in on mount and dropped on
 *  unmount. Null while the pane is off-screen — the terminal keeps running. */
export interface HostView {
  readonly setDetached: (v: boolean) => void
  readonly setAttachError: (v: string | null) => void
}

export interface TerminalHost {
  /** The reparented element. `term.open()` was called against this exactly once. */
  readonly surface: HTMLDivElement
  readonly handle: XtermHandle
  readonly sessionId: SessionId
  readonly dispose: () => void
  view: HostView | null
  /** Mirrors of the view state, so a remounting pane resumes where it left off. */
  detached: boolean
  attachError: string | null
}

const hosts = new Map<string, TerminalHost>()

const create = (sessionId: SessionId): TerminalHost => {
  const surface = document.createElement("div")
  surface.className = "term-surface"

  const handle = createTerminal(surface)
  const { term, fit } = handle

  let lastCols = 0
  let lastRows = 0
  let frame = 0
  let disposed = false

  // Geometry is negotiated after layout settles and on every container resize,
  // so the child's TTY winsize stays truthful.
  //
  // The guards matter: fitting before the flex layout has run — or while the
  // surface is parked off-document between slots — measures a near-zero box, and
  // pushing THAT to the engine makes the child rewrap its output to a couple of
  // columns. That corruption survives the later correct resize, because the
  // damage is already in the scrollback.
  const pushSize = (): void => {
    frame = 0
    if (disposed || !surface.isConnected) return
    const proposed = fit.proposeDimensions()
    if (proposed === undefined || proposed.cols < 8 || proposed.rows < 2) return
    if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return

    fit.fit()
    if (term.cols === lastCols && term.rows === lastRows) return
    lastCols = term.cols
    lastRows = term.rows
    resizeSession(sessionId, term.cols, term.rows)
  }

  // Coalesce to one fit per frame; a docked pane fires several resizes as the
  // split animates in, and a reparent fires one more.
  const scheduleSize = (): void => {
    if (frame !== 0 || disposed) return
    frame = requestAnimationFrame(pushSize)
  }

  const observer = new ResizeObserver(scheduleSize)
  observer.observe(surface)

  const offInput = term.onData((data) => sendInput(sessionId, data))

  // Both are wired below but torn down here; the callbacks that create them need
  // `entry` to exist first, so the references are filled in after construction.
  let offScroll: { dispose: () => void } | undefined
  let unsubscribe: (() => void) | undefined

  const entry: TerminalHost = {
    surface,
    handle,
    sessionId,
    view: null,
    detached: false,
    attachError: null,
    dispose: () => {
      disposed = true
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
      unsubscribe?.()
      offInput.dispose()
      offScroll?.dispose()
      handle.dispose()
      surface.remove()
    }
  }

  // Show the jump-to-latest control whenever the viewport sits above the
  // scrollback base — i.e. the user scrolled up off the tail. xterm holds
  // position on new output while detached, so this reads true until they return
  // to the bottom (manually or via the button).
  offScroll = term.onScroll(() => {
    const b = term.buffer.active
    const detached = b.viewportY < b.baseY
    if (detached === entry.detached) return
    entry.detached = detached
    entry.view?.setDetached(detached)
  })

  // The subscription belongs to the surface, not to the mounted component: a
  // pane that is off-screen (moved, fullscreened elsewhere, another project
  // selected) must keep collecting output, or coming back would show a hole.
  unsubscribe = subscribeSession(sessionId, {
    onData: (bytes) => term.write(bytes),
    onExit: (exitCode) => useTerminals.getState().markExited(sessionId, exitCode),
    onReset: () => term.reset(),
    onError: (message) => {
      entry.attachError = message
      entry.view?.setAttachError(message)
      if (message === null) scheduleSize()
    }
  })

  return entry
}

/** The surface for a pane, built on first use. A new session id means a restart:
 *  its output belongs in a clean buffer, so the old surface is retired. */
export const acquireHost = (paneId: string, sessionId: SessionId): TerminalHost => {
  const existing = hosts.get(paneId)
  if (existing !== undefined) {
    if (existing.sessionId === sessionId) return existing
    existing.dispose()
    hosts.delete(paneId)
  }
  const entry = create(sessionId)
  hosts.set(paneId, entry)
  return entry
}

/** Re-attach a pane whose last attach failed.
 *
 *  Called when the thing the pane is watching starts running. A failed attach
 *  otherwise sticks forever on a RUN pane, because its session id never changes
 *  between starts — so the pane reuses this host, and neither of the two normal
 *  re-attach triggers (a new session id, a socket reconnect) ever fires. The
 *  guard on `attachError` keeps this to the recovery path: a pane that is
 *  streaming happily is left alone rather than being made to replay. */
export const retryAttach = (paneId: string): void => {
  const host = hosts.get(paneId)
  if (host === undefined || host.attachError === null) return
  reattachSession(host.sessionId)
}

/** Wipe a pane's surface, if it has one.
 *
 *  The surface outlives the component that renders it — that is the whole point
 *  of this registry — so clearing must be addressed to the HOST, not to a ref
 *  the pane happens to be holding. The pane's ref is dropped every time the
 *  session id changes, which includes the moment a project stops: exactly when
 *  there is old output on screen and the user reaches for Clear.
 *
 *  `term.reset()` rather than xterm's `clear()`: `clear()` early-returns when
 *  nothing has scrolled off the top, so a terminal whose output still fits the
 *  viewport — a project that printed a dozen lines and stopped — would not
 *  visibly change. The session is being cleared wholesale here, so dropping
 *  terminal modes with it is correct rather than merely acceptable. */
export const clearHost = (paneId: string): void => {
  hosts.get(paneId)?.handle.term.reset()
}

/** Retire surfaces whose panes are no longer tiled anywhere. Closing a pane is
 *  the intent to discard its scrollback; merely unmounting one is not. */
export const sweepHosts = (live: ReadonlySet<string>): void => {
  for (const [paneId, entry] of hosts) {
    if (live.has(paneId)) continue
    entry.dispose()
    hosts.delete(paneId)
  }
}
