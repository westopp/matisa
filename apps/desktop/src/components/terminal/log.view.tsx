import { useEffect, useMemo, useRef, useState } from "react"
import type { ProjectWithState } from "@matisa/core"
import { useLogs, type LogEntry } from "~/store/store.logs"
import { Icons } from "../icons"

// ────────────────────────────────────────────────────────────────────────────
// Read-only log pane for docker/compose run panes — the container's output,
// not a terminal. Fed by log_line events; the buffer lives in store.logs and
// survives pane close/reopen (parity with the PTY panes, whose scrollback the
// engine replays).
//
// Compose: the engine attributes each line to its service, so the filter here
// is a plain dropdown over what the buffer has actually seen — no service
// enumeration round-trip, and a service that never logs never appears.
// ────────────────────────────────────────────────────────────────────────────

const NONE: ReadonlyArray<LogEntry> = []

/** How many lines the DOM holds; the buffer keeps MAX_LINES regardless. */
const WINDOW = 300

/** Colour belongs to the pane theme, not the container. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const plain = (line: string): string => line.replace(ANSI, "")

export const LogView = ({ project }: { project: ProjectWithState }) => {
  const entries = useLogs((s) => s.logs[project.id]) ?? NONE
  const clear = useLogs((s) => s.clear)
  const [filter, setFilter] = useState<string | null>(null)

  const services = useMemo(
    () => [...new Set(entries.map((e) => e.service).filter((s): s is string => s !== undefined))].sort(),
    [entries]
  )
  const shown = filter === null ? entries : entries.filter((e) => e.service === filter)

  // Render only the tail. The pane pins to the bottom and the buffer caps at
  // 2k, so a window over the last WINDOW lines is virtualization enough — the
  // DOM stays a fixed size however fast lines arrive. Deep scrollback is what
  // `docker logs` is for.
  const visible = shown.slice(-WINDOW)
  const hidden = shown.length - visible.length

  // Stick to the bottom unless the user has scrolled up to read — the same
  // contract xterm gives the PTY panes. `pinnedRef` drives the auto-scroll
  // synchronously; `detached` is the reactive mirror that surfaces the
  // jump-to-latest control (and only surfaces it when there is a tail to jump to).
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const [detached, setDetached] = useState(false)
  useEffect(() => {
    const el = bodyRef.current
    if (el !== null && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [shown.length, filter])

  const onScroll = (): void => {
    const el = bodyRef.current
    if (el === null) return
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    pinnedRef.current = pinned
    setDetached(!pinned)
  }

  const jumpToBottom = (): void => {
    const el = bodyRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
    pinnedRef.current = true
    setDetached(false)
  }

  // A stale filter must not silently show nothing: if the buffer was cleared or
  // rolled past every line from the chosen service, fall back to All.
  useEffect(() => {
    if (filter !== null && !services.includes(filter)) setFilter(null)
  }, [services, filter])

  return (
    <div className="log-view">
      <div className="log-toolbar">
        {services.length > 0 && (
          <select
            className="log-filter"
            value={filter ?? ""}
            onChange={(e) => setFilter(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">All services</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <span className="log-count">
          {shown.length === 0 ? "" : `${shown.length} lines`}
        </span>
        <span className="term-spacer" />
        <button className="ico" title="Clear logs" onClick={() => clear(project.id)}>
          <Icons.Trash size={12} />
        </button>
      </div>

      <div className="log-body scroll" ref={bodyRef} onScroll={onScroll}>
        {shown.length === 0 ? (
          <div className="log-empty">
            {project.state === "running"
              ? "No log output yet."
              : "Not running — logs stream while the " +
                (project.kind === "compose" ? "stack" : "container") +
                " is up."}
          </div>
        ) : (
          <>
            {hidden > 0 && (
              <div className="log-more">… {hidden} earlier lines buffered</div>
            )}
            {visible.map((e, i) => (
              <div key={i} className={`log-line ${e.stream}`}>
                {filter === null && e.service !== undefined && (
                  <span className="log-service">{e.service}</span>
                )}
                <span className="log-text">{plain(e.line)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {detached && (
        <button className="jump-bottom" title="Jump to latest" onClick={jumpToBottom} aria-label="Jump to latest">
          <Icons.ArrowDownCircle size={20} />
        </button>
      )}
    </div>
  )
}
