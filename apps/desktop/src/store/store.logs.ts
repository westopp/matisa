import { create } from "zustand"
import type { ProjectId } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// Container/stack log buffers, per project. Docker and compose projects have no
// PTY; their output arrives as log_line events, and this ring buffer is what
// the log pane renders. Capped so a chatty container costs a fixed amount of
// memory — the cap, not persistence, is the flood control (the durable copy is
// the engine's events table).
// ────────────────────────────────────────────────────────────────────────────

export interface LogEntry {
  /** Monotonic across the session — the render key. Keying on the array index
   *  remounted every visible line whenever the ring rolled, because content
   *  shifts under stable indices. */
  readonly id: number
  readonly ts: number
  readonly stream: "stdout" | "stderr"
  readonly line: string
  /** Compose only: which service in the stack said it. */
  readonly service?: string
}

/** What callers hand to `append` — identity and normalisation happen here. */
export type LogInput = Omit<LogEntry, "id">

const MAX_LINES = 2_000

let nextId = 1

/** Colour belongs to the pane theme, not the container. Stripped ONCE here at
 *  append rather than per render — the old per-render strip re-ran this regex
 *  over the whole visible window on every flush. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

// Appends are BATCHED: lines land in a plain module-level buffer and the store
// publishes once per flush interval, so a container logging hundreds of lines a
// second costs the UI ten renders a second, not hundreds. The buffer is not
// state — nothing renders it — which is what makes the per-line cost an array
// push instead of a store update.
const FLUSH_MS = 100

const pending = new Map<string, Array<LogEntry>>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

const flush = (): void => {
  flushTimer = null
  const batches = [...pending.entries()]
  pending.clear()
  useLogs.setState((s) => {
    const logs = { ...s.logs }
    for (const [projectId, entries] of batches) {
      const merged = [...(logs[projectId] ?? []), ...entries]
      logs[projectId] = merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged
    }
    return { logs }
  })
}

interface LogsState {
  logs: Record<string, ReadonlyArray<LogEntry>>
  append: (projectId: ProjectId, entry: LogInput) => void
  clear: (projectId: ProjectId) => void
}

export const useLogs = create<LogsState>()((set) => ({
  logs: {},

  append: (projectId, input) => {
    const entry: LogEntry = { ...input, id: nextId++, line: input.line.replace(ANSI, "") }
    const bucket = pending.get(projectId)
    if (bucket === undefined) pending.set(projectId, [entry])
    else bucket.push(entry)
    if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS)
  },

  clear: (projectId) => {
    // Both halves: the published buffer AND whatever is waiting to flush,
    // otherwise a clear during a burst resurrects up to 100ms of lines.
    pending.delete(projectId)
    set((s) => {
      if (s.logs[projectId] === undefined) return s
      const next = { ...s.logs }
      delete next[projectId]
      return { logs: next }
    })
  }
}))
