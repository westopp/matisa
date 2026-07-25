import type { SessionId } from "@matisa/core"
import { rpc } from "./rpc.client"

// ────────────────────────────────────────────────────────────────────────────
// Per-session attach registry.
//
// `pty.attach` forks a pump on the ENGINE side of the connection and there is
// no detach — so attaching the same session twice on one connection means the
// engine pushes every byte twice. That happens easily: a pane shown both tiled
// and fullscreen, or React re-mounting an effect. So attach is refcounted here
// and the bytes are fanned out to every subscriber.
//
// On reconnect the engine-side pumps are gone with the socket, so every live
// session re-attaches; subscribers are told to reset first because the attach
// replays scrollback from the top.
// ────────────────────────────────────────────────────────────────────────────

export interface SessionHandlers {
  readonly onData: (bytes: Uint8Array) => void
  readonly onExit: (exitCode: number | null) => void
  /** Fired before a re-attach replays scrollback — clear the view. */
  readonly onReset: () => void
  readonly onError: (message: string | null) => void
}

interface Entry {
  readonly listeners: Set<SessionHandlers>
  /** The connection generation this session is attached on; -1 when detached. */
  attachedOn: number
  /** Bytes that arrived before any pane subscribed (see `expectSelfBridged`). */
  pending: Array<Uint8Array>
  exitCode: number | null
  exited: boolean
}

const newEntry = (): Entry => ({ listeners: new Set(), attachedOn: -1, pending: [], exitCode: null, exited: false })

/** Cap the pre-subscribe buffer; the engine replays scrollback on reattach, so
 *  this only has to cover the gap between an RPC ack and the pane mounting. */
const MAX_PENDING_CHUNKS = 512

const decode = (b64: string): Uint8Array => {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const entries = new Map<string, Entry>()
let generation = 0

const attach = (sessionId: SessionId, entry: Entry): void => {
  const at = generation
  entry.attachedOn = at
  void rpc
    .call("pty.attach", { sessionId })
    .then(() => {
      for (const l of entry.listeners) l.onError(null)
    })
    .catch((cause: unknown) => {
      // Only surface a failure that is still current; a stale generation just
      // means the socket flipped underneath us and a fresh attach is coming.
      if (entry.attachedOn !== at) return
      entry.attachedOn = -1
      const message = cause instanceof Error ? cause.message : String(cause)
      for (const l of entry.listeners) l.onError(message)
    })
}

/** Register a session the engine ALREADY bridged onto this connection.
 *
 *  `pty.open` and `commands.run` bridge the session as part of the call, so a
 *  later `pty.attach` would fork a second pump and double every byte. Call this
 *  with the session id the creating RPC returned; a silent command produces no
 *  output to claim the session implicitly, so this marker is what keeps the
 *  pane from attaching a second time. */
export const expectSelfBridged = (sessionId: SessionId): void => {
  const entry = entries.get(sessionId) ?? newEntry()
  entry.attachedOn = generation
  entries.set(sessionId, entry)
}

export const subscribeSession = (sessionId: SessionId, handlers: SessionHandlers): (() => void) => {
  let entry = entries.get(sessionId)
  if (entry === undefined) {
    entry = newEntry()
    entries.set(sessionId, entry)
  }
  entry.listeners.add(handlers)

  // Anything buffered before the first pane mounted belongs to it.
  if (entry.pending.length > 0) {
    for (const chunk of entry.pending) handlers.onData(chunk)
    entry.pending = []
  }
  if (entry.exited) handlers.onExit(entry.exitCode)

  if (entry.attachedOn !== generation) {
    attach(sessionId, entry)
  } else {
    // Already streaming — either self-bridged by its creating call, or another
    // pane attached first. The engine has no "replay again", so a late second
    // pane starts from the current tail.
    handlers.onError(null)
  }

  const current = entry
  return () => {
    current.listeners.delete(handlers)
    // The entry survives at zero listeners: the engine-side pump is still
    // running, so re-subscribing must NOT attach a second time.
  }
}

rpc.onNotify((n) => {
  if (n.method !== "pty.output" && n.method !== "pty.exit") return
  const params = n.params as { sessionId?: string; data?: string; exitCode?: number | null } | undefined
  if (params?.sessionId === undefined) return

  // Output can arrive for a session we have not registered yet: `commands.run`
  // bridges the session DURING the call, so its first bytes reach us before the
  // response that names the session. Claim it here (the engine is demonstrably
  // already streaming it) and buffer until the pane mounts.
  let entry = entries.get(params.sessionId)
  if (entry === undefined) {
    entry = newEntry()
    entry.attachedOn = generation
    entries.set(params.sessionId, entry)
  }

  if (n.method === "pty.output" && typeof params.data === "string") {
    const bytes = decode(params.data)
    if (entry.listeners.size === 0) {
      if (entry.pending.length < MAX_PENDING_CHUNKS) entry.pending.push(bytes)
      return
    }
    for (const l of entry.listeners) l.onData(bytes)
  } else if (n.method === "pty.exit") {
    entry.exited = true
    entry.exitCode = params.exitCode ?? null
    for (const l of entry.listeners) l.onExit(entry.exitCode)
  }
})

rpc.onStatus((status) => {
  if (status !== "open") {
    for (const entry of entries.values()) entry.attachedOn = -1
  }
})

rpc.onOpen(() => {
  generation++
  for (const [sessionId, entry] of entries) {
    if (entry.listeners.size === 0) {
      // Nothing is watching; drop it so a stale session id cannot pin memory.
      entries.delete(sessionId)
      continue
    }
    entry.pending = []
    for (const l of entry.listeners) l.onReset()
    attach(sessionId as SessionId, entry)
  }
})

/** xterm → engine: keystrokes as UTF-8 bytes, base64-encoded. `btoa` is
 *  latin1-only, so encode to bytes first — otherwise any non-ASCII key
 *  (é, an emoji, a paste) throws. */
export const encodeChunk = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Ctrl-C — what a command pane's stop button sends. */
export const SIGINT_SEQUENCE = ""

export const sendInput = (sessionId: SessionId, text: string): void => {
  void rpc.call("pty.input", { sessionId, data: encodeChunk(text) }).catch(() => {})
}

/** Tell the engine the viewer's geometry so the child's TTY winsize is truthful.
 *  Failures are deliberately silent: a resize racing a session teardown is
 *  routine and reporting it would be noise, not information. */
export const resizeSession = (sessionId: SessionId, cols: number, rows: number): void => {
  void rpc.call("pty.resize", { sessionId, cols, rows }).catch(() => {})
}

/** Close a session for good: the engine kills the pty, and the local registry
 *  entry goes with it so a later attach cannot resurrect a dead id.
 *
 *  Detaching alone is not closing. Sessions deliberately outlive their panes —
 *  that is what makes a pane reopen where it left off — so the ONLY thing that
 *  ends an ad-hoc shell is this call. Without it, every terminal ever opened
 *  stayed a live $SHELL process on the engine.
 *
 *  Run sessions are the supervisor's; the engine rejects closing them, and
 *  callers must not offer it. */
export const closeSession = (sessionId: SessionId): void => {
  entries.delete(sessionId)
  void rpc.call("pty.close", { sessionId }).catch(() => {})
}

/** Drop the engine's scrollback for a session, so a later attach replays nothing
 *  from before now. The process is untouched, and unlike `closeSession` this is
 *  valid for a `run:` session too — clearing a view cannot stop a project.
 *
 *  The local xterm is cleared by the caller: this only forgets the RECORD, and
 *  without it a reload would faithfully restore everything just cleared. */
export const clearSession = (sessionId: SessionId): Promise<void> =>
  rpc.call("pty.clear", { sessionId }).then(
    () => undefined,
    () => undefined
  )
