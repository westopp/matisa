import { constants as osConstants } from "node:os"
import type { PubSub } from "effect"
import type { IPty } from "node-pty"
import type { ProjectId, SessionId } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// Session primitives shared by PtyManager and the supervisor's run sessions.
//
// Every chunk carries a monotonically increasing per-session `seq` so an
// attach can replay the scrollback ring and then consume the live hub without
// duplicating the chunks that arrived between snapshot and subscribe — the
// pump simply skips seq ≤ the last replayed one.
// ────────────────────────────────────────────────────────────────────────────

/** A frame published on a session's hub: live output or the terminal exit. */
export type PtyFrame =
  | { readonly kind: "data"; readonly seq: number; readonly data: string } // base64
  | { readonly kind: "exit"; readonly seq: number; readonly exitCode: number | null }

export interface SessionEntry {
  readonly sessionId: SessionId
  readonly projectId: ProjectId
  /** "run" = the supervised process itself; "shell" = an ad-hoc pty.open. */
  readonly kind: "run" | "shell"
  readonly pty: IPty
  readonly hub: PubSub.PubSub<PtyFrame>
  readonly scrollback: Scrollback
  cols: number
  rows: number
  exited: boolean
  exitCode: number | null
}

/** Byte-capped ring of seq-numbered base64 chunks (drops from the front). */
export class Scrollback {
  private chunks: Array<{ seq: number; data: string; bytes: number }> = []
  private total = 0
  private nextSeq = 1

  constructor(private readonly maxBytes: number) {}

  /** Append raw pty output; returns the chunk's seq. */
  push(utf8: string): { seq: number; data: string } {
    const data = Buffer.from(utf8, "utf8").toString("base64")
    const bytes = data.length
    const seq = this.nextSeq++
    this.chunks.push({ seq, data, bytes })
    this.total += bytes
    while (this.total > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      if (dropped) this.total -= dropped.bytes
    }
    return { seq, data }
  }

  /** Reserve a seq without data — used for the exit frame. */
  bumpSeq(): number {
    return this.nextSeq++
  }

  snapshot(): ReadonlyArray<{ seq: number; data: string }> {
    return this.chunks.map(({ seq, data }) => ({ seq, data }))
  }
}

// node-pty reports the killing signal as a number; the FSM speaks names.
const SIGNAL_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(osConstants.signals).map(([name, num]) => [num, name])
)

export const signalName = (num: number | undefined): string | null =>
  num === undefined || num === 0 ? null : (SIGNAL_NAMES.get(num) ?? `SIG${num}`)

/** Deterministic session id for a project's supervised run. */
export const runSessionId = (projectId: ProjectId): string => `run:${projectId}`
