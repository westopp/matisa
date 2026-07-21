import { useEffect, useRef, useState } from "react"
import type { Terminal } from "@xterm/xterm"
import type { ProjectWithState } from "@matisa/core"
import { resizeSession, sendInput, SIGINT_SEQUENCE, subscribeSession } from "~/rpc/rpc.pty"
import { useEngine } from "~/store/store.engine"
import { useTerminals, type DropSide, type Pane } from "~/store/store.terminals"
import { Icons } from "../icons"
import { StatusDot } from "../primitives"
import { LogView } from "./log.view"
import { createTerminal, terminalTheme } from "./terminal.xterm"

// ────────────────────────────────────────────────────────────────────────────
// One tiled pane = one live xterm view of one engine PTY session.
//
// The pane owns no process and no attach: it subscribes through the refcounted
// registry in rpc.pty.ts, which guarantees the engine is streaming a session
// exactly once per connection however many panes are showing it. Closing a pane
// closes a view — the session keeps running and reattaches on reopen or reload.
// ────────────────────────────────────────────────────────────────────────────

const zoneFromEvent = (e: React.DragEvent, el: HTMLElement): DropSide => {
  const r = el.getBoundingClientRect()
  const fx = (e.clientX - r.left) / r.width
  const fy = (e.clientY - r.top) / r.height
  const d: Record<DropSide, number> = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }
  return (Object.keys(d) as Array<DropSide>).reduce((a, b) => (d[b] < d[a] ? b : a))
}

interface Props {
  readonly pane: Pane
  readonly project: ProjectWithState
  readonly theme: string
  readonly fullscreen?: boolean
  readonly canClose: boolean
}

export const TerminalPane = ({ pane, project, theme, fullscreen = false, canClose }: Props) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)

  const stop = useEngine((s) => s.stop)
  const markExited = useTerminals((s) => s.markExited)
  const closePane = useTerminals((s) => s.closePane)
  const setFullscreen = useTerminals((s) => s.setFullscreen)
  const setDrag = useTerminals((s) => s.setDrag)
  const setDropTarget = useTerminals((s) => s.setDropTarget)
  const dock = useTerminals((s) => s.dock)
  const dragPaneId = useTerminals((s) => s.dragPaneId)
  const dropTarget = useTerminals((s) => s.dropTarget)

  const sessionId = pane.sessionId

  useEffect(() => {
    const host = hostRef.current
    if (host === null || sessionId === null) return

    const handle = createTerminal(host)
    const { term, fit } = handle
    termRef.current = term
    let disposed = false

    const offInput = term.onData((data) => sendInput(sessionId, data))

    // Geometry is negotiated after layout settles and on every container
    // resize, so the child's TTY winsize stays truthful.
    //
    // The guard matters: fitting before the flex layout has run measures a
    // near-zero box, and pushing THAT to the engine makes the child rewrap its
    // output to a couple of columns — visible corruption that survives the
    // later correct resize, because the damage is already in the scrollback.
    let lastCols = 0
    let lastRows = 0
    let frame = 0

    const pushSize = (): void => {
      frame = 0
      if (disposed) return
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
    // split animates in.
    const scheduleSize = (): void => {
      if (frame !== 0 || disposed) return
      frame = requestAnimationFrame(pushSize)
    }

    const observer = new ResizeObserver(scheduleSize)
    observer.observe(host)
    scheduleSize()

    const unsubscribe = subscribeSession(sessionId, {
      onData: (bytes) => term.write(bytes),
      onExit: (exitCode) => markExited(sessionId, exitCode),
      onReset: () => term.reset(),
      onError: (message) => {
        setAttachError(message)
        if (message === null) scheduleSize()
      }
    })

    return () => {
      disposed = true
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
      unsubscribe()
      offInput.dispose()
      handle.dispose()
      termRef.current = null
    }
  }, [sessionId, markExited])

  // Re-theme in place on a light/dark flip. Rebuilding the terminal instead
  // would drop the scrollback the engine already replayed into it.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    term.options.theme = terminalTheme()
  }, [theme])

  const isDragging = dragPaneId === pane.paneId
  const showDrop =
    !fullscreen && dropTarget?.paneId === pane.paneId && dragPaneId !== null && dragPaneId !== pane.paneId
      ? dropTarget.side
      : null

  const onStop = (): void => {
    if (pane.kind === "run") {
      void stop(project.id)
      return
    }
    if (sessionId !== null) sendInput(sessionId, SIGINT_SEQUENCE)
  }

  // The run pane of a docker/compose project is a LOG pane: there is no PTY to
  // attach, but the engine streams the container's (or stack's) output as
  // log_line events, and that is what this pane shows.
  const isLogPane = pane.kind === "run" && project.kind !== "process"

  const running = isLogPane ? project.state === "running" : pane.sessionId !== null && !pane.exited

  return (
    <div
      className={`term ${isDragging ? "dragging" : ""}`}
      onDragOver={
        fullscreen
          ? undefined
          : (e) => {
              if (dragPaneId === null || dragPaneId === pane.paneId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = "move"
              setDropTarget({ paneId: pane.paneId, side: zoneFromEvent(e, e.currentTarget) })
            }
      }
      onDrop={
        fullscreen
          ? undefined
          : (e) => {
              e.preventDefault()
              dock(project.id, pane.paneId, zoneFromEvent(e, e.currentTarget))
            }
      }
    >
      <header
        className="term-head"
        draggable={!fullscreen}
        onDragStart={
          fullscreen
            ? undefined
            : (e) => {
                setDrag(pane.paneId)
                e.dataTransfer.effectAllowed = "move"
                e.dataTransfer.setData("text/plain", pane.paneId)
              }
        }
        onDragEnd={
          fullscreen
            ? undefined
            : () => {
                setDrag(null)
                setDropTarget(null)
              }
        }
      >
        {!fullscreen && (
          <span className="term-grip" title="Drag to rearrange">
            <Icons.Grip size={14} />
          </span>
        )}
        <span className="term-title">{pane.title}</span>
        <span className="term-status">
          <StatusDot state={running ? "running" : "idle"} size={6} />
          <span className="file-label">{pane.subtitle}</span>
        </span>
        {pane.exited && (
          <span className={`term-exit-badge ${pane.exitCode === 0 ? "ok" : ""}`}>
            exit {pane.exitCode ?? "signal"}
          </span>
        )}
        <span className="term-spacer" />

        <button
          className="ico danger-hover"
          title={pane.kind === "run" ? "Stop the process" : "Interrupt (Ctrl-C)"}
          onClick={onStop}
          disabled={!running}
        >
          <Icons.Stop size={11} />
        </button>
        <button
          className="ico"
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={() => setFullscreen(fullscreen ? null : pane.paneId)}
        >
          {fullscreen ? <Icons.Minimize size={13} /> : <Icons.Maximize size={13} />}
        </button>
        {!fullscreen && canClose && (
          <button className="ico danger-hover" title="Close pane" onClick={() => closePane(project.id, pane.paneId)}>
            <Icons.X size={13} />
          </button>
        )}
      </header>

      {isLogPane ? (
        <LogView project={project} />
      ) : (
        <div className="term-body" ref={hostRef}>
          {sessionId === null && (
            <div className="term-detached">
              <div>No session yet — start the project to attach a terminal.</div>
            </div>
          )}
          {attachError !== null && (
            <div className="term-detached">
              <div>Could not attach: {attachError}</div>
            </div>
          )}
        </div>
      )}

      {showDrop !== null && <div className={`drop-hl side-${showDrop}`} />}
    </div>
  )
}
