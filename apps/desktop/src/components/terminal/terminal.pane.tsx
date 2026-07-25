import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { Terminal } from "@xterm/xterm"
import type { ProjectWithState } from "@matisa/core"
import { clearSession, closeSession } from "~/rpc/rpc.pty"
import { useCommandRunner } from "~/hooks/use-command-run"
import { useLifecycleState } from "~/hooks/use-lifecycle-state"
import { useEngine } from "~/store/store.engine"
import { useTerminals, type DropSide, type Pane } from "~/store/store.terminals"
import { Icons } from "../icons"
import { CommandRunButton, KillButton, LifecycleButton, StatusDot } from "../primitives"
import { acquireHost, type HostView } from "./terminal.hosts"
import { LogView } from "./log.view"
import { terminalTheme } from "./terminal.xterm"

// ────────────────────────────────────────────────────────────────────────────
// One tiled pane = one live xterm view of one engine PTY session.
//
// The pane owns no process, no attach and — deliberately — not the terminal
// either. The xterm surface lives in terminal.hosts.ts and is reparented into
// this component's slot, so unmounting the pane (a dock, a fullscreen toggle, a
// project switch) never destroys the scrollback. What this component owns is the
// chrome: title, status, drag/drop zones and the overlay controls.
//
// Closing a pane closes a view — the session keeps running in the engine and
// reattaches on reopen or reload.
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
  const slotRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [detached, setDetached] = useState(false)

  const kill = useEngine((s) => s.kill)
  const { busy } = useLifecycleState(project)
  const {
    statusOf,
    run: runCommand,
    stop: stopCommand,
    kill: killCommand
  } = useCommandRunner(project.id)
  const closePane = useTerminals((s) => s.closePane)
  const setFullscreen = useTerminals((s) => s.setFullscreen)
  const setDrag = useTerminals((s) => s.setDrag)
  const setDropTarget = useTerminals((s) => s.setDropTarget)
  const dock = useTerminals((s) => s.dock)
  const dragPaneId = useTerminals((s) => s.dragPaneId)
  const dropTarget = useTerminals((s) => s.dropTarget)
  const fullscreenId = useTerminals((s) => s.fullscreen)

  const sessionId = pane.sessionId

  // A fullscreened pane is rendered TWICE — once in the tile it came from, once
  // in the overlay — and a DOM element has one parent. The overlay copy takes
  // the surface; the tiled copy stands down (it is behind the overlay anyway)
  // and reclaims it when fullscreen ends. Deciding by state rather than by
  // effect order keeps the handover deterministic.
  const owns = fullscreen || fullscreenId !== pane.paneId

  // Reparent, don't rebuild. A layout effect so the surface is in place before
  // paint — the same commit that moves a pane also moves its terminal, with no
  // frame of empty box in between.
  useLayoutEffect(() => {
    const slot = slotRef.current
    if (slot === null || sessionId === null || !owns) return

    const host = acquireHost(pane.paneId, sessionId)
    if (host.surface.parentElement !== slot) slot.appendChild(host.surface)
    termRef.current = host.handle.term

    // Resume the view state the surface carried while it was off-screen.
    setDetached(host.detached)
    setAttachError(host.attachError)

    const view: HostView = { setDetached, setAttachError }
    host.view = view
    return () => {
      if (host.view === view) host.view = null
      termRef.current = null
    }
  }, [pane.paneId, sessionId, owns])

  // Re-theme in place on a light/dark flip. Rebuilding the terminal instead
  // would drop the scrollback the engine already replayed into it.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    term.options.theme = terminalTheme()
  }, [theme, sessionId, owns])

  const isDragging = dragPaneId === pane.paneId
  const showDrop =
    !fullscreen && dropTarget?.paneId === pane.paneId && dragPaneId !== null && dragPaneId !== pane.paneId
      ? dropTarget.side
      : null

  // Closing a COMMAND pane ends its session for good — the terminal is the only
  // handle on it, so leaving the pty alive would strand a process nothing can
  // reach. A run pane is the supervised project: its session belongs to the
  // supervisor, and closing the view must never touch it.
  const onClose = (): void => {
    if (pane.kind !== "run" && sessionId !== null) closeSession(sessionId)
    closePane(project.id, pane.paneId)
  }

  const jumpToBottom = (): void => {
    const term = termRef.current
    if (term === null) return
    term.scrollToBottom()
    setDetached(false)
  }

  // Clear the view AND the engine's record of it. Clearing only xterm would look
  // right until the next reload replayed everything back — the scrollback the
  // pane shows is the engine's, not the browser's.
  const onClear = (): void => {
    termRef.current?.clear()
    setDetached(false)
    if (sessionId !== null) void clearSession(sessionId)
  }

  // The run pane of a docker/compose project is a LOG pane: there is no PTY to
  // attach, but the engine streams the container's (or stack's) output as
  // log_line events, and that is what this pane shows.
  const isLogPane = pane.kind === "run" && project.kind !== "process"

  const running = isLogPane ? project.state === "running" : pane.sessionId !== null && !pane.exited

  // Kill means the same thing everywhere — end it now, no drain — but reaches a
  // different owner per pane kind. A run pane's process belongs to the
  // supervisor; a command's belongs to its pty, and closing that session IS the
  // kill, since nothing else holds a handle on it.
  const killable = pane.kind === "run" ? running || busy : running
  const killTitle =
    pane.kind === "run" ? "Force kill the project — no drain, no waiting" : "Kill this command"
  const commandStatus = statusOf(pane.commandName ?? pane.title)
  const onKill = (): void => {
    if (pane.kind === "run") {
      void kill(project.id)
      return
    }
    killCommand(pane.commandName ?? pane.title)
  }

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

        {/* The same control trio as everywhere else, in the same order: kill,
            then start/stop/loading in one slot. A pane's process is the thing
            the pane is FOR, so it is driven from here rather than only from the
            card upstairs. */}
        <KillButton enabled={killable} onKill={onKill} title={killTitle} size={14} />
        {pane.kind === "run" ? (
          <LifecycleButton project={project} />
        ) : (
          <CommandRunButton
            status={commandStatus}
            onRun={() => void runCommand(pane.commandName ?? pane.title, pane.subtitle)}
            onStop={() => stopCommand(pane.commandName ?? pane.title)}
          />
        )}
        {!isLogPane && (
          <button className="ico" title="Clear terminal" onClick={onClear} disabled={sessionId === null}>
            <Icons.Eraser size={13} />
          </button>
        )}
        <button
          className="ico"
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={() => setFullscreen(fullscreen ? null : pane.paneId)}
        >
          {fullscreen ? <Icons.Minimize size={13} /> : <Icons.Maximize size={13} />}
        </button>
        {/* A terminal outlives its process — it stays put through an exit or a
            crash so the output is still there to read. What it must NOT do is
            close while the process is alive, which would strand something
            running with no window onto it. Stop it or kill it first. */}
        {!fullscreen && canClose && (
          <button
            className="ico danger-hover"
            title={running ? "Stop or kill the process before closing" : "Close pane"}
            disabled={running}
            onClick={onClose}
          >
            <Icons.X size={13} />
          </button>
        )}
      </header>

      {isLogPane ? (
        <LogView project={project} />
      ) : (
        <div className="term-body">
          {/* Left empty on purpose: the xterm surface is appended here by the
              host registry, so React must never render children into it. */}
          {/* No "nothing here yet" overlay: an idle project's terminal is a
              terminal that has not run, and the card above already says so in
              the one place status belongs. */}
          <div className="term-slot" ref={slotRef} />
          {attachError !== null && (
            <div className="term-detached">
              <div>Could not attach: {attachError}</div>
            </div>
          )}
          {detached && (
            <button className="jump-bottom" title="Jump to latest" onClick={jumpToBottom} aria-label="Jump to latest">
              <Icons.ArrowDownCircle size={20} />
            </button>
          )}
        </div>
      )}

      {showDrop !== null && <div className={`drop-hl side-${showDrop}`} />}
    </div>
  )
}
