import { useEffect, useRef, useState } from "react"
import type { ProjectWithState } from "@matisa/core"
import { expectSelfBridged } from "~/rpc/rpc.pty"
import { useEngine } from "~/store/store.engine"
import {
  collectPaneIds,
  runPaneId,
  shellPaneId,
  useTerminals,
  type LayoutNode
} from "~/store/store.terminals"
import { useUi } from "~/store/store.ui"
import { Icons } from "../icons"
import { CollapsibleCard } from "../panels"
import { QuickMenu } from "../quick.commands"
import { commandLine } from "../primitives"
import { sweepHosts } from "./terminal.hosts"
import { TerminalPane } from "./terminal.pane"

// ────────────────────────────────────────────────────────────────────────────
// The tiling shell: renders the split tree and hosts the divider drag.
//
// A terminal is the VIEW of a running process, and that rule is what decides
// which controls belong here. There is no "empty terminal" button, because it
// would be a window onto nothing. There IS a New shell button, because a shell
// is a process — $SHELL, in the project's directory, with the project's
// resolved environment. That environment is the point: the layered contexts and
// keychain secrets are assembled by the engine at spawn, so a terminal opened
// anywhere else has the directory and none of the rest.
// ────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

const SplitContainer = ({
  node,
  project,
  theme,
  canCloseRun
}: {
  node: Extract<LayoutNode, { type: "split" }>
  project: ProjectWithState
  theme: string
  canCloseRun: boolean
}) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const resize = useTerminals((s) => s.resize)
  const horizontal = node.dir === "row"

  const onDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const el = ref.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const total = horizontal ? rect.width : rect.height
    const start = horizontal ? e.clientX : e.clientY
    const first = node.sizes[0]

    const move = (ev: MouseEvent): void => {
      const cur = horizontal ? ev.clientX : ev.clientY
      const next = clamp(first + ((cur - start) / total) * 100, 14, 86)
      resize(project.id, node.id, [next, 100 - next])
    }
    const up = (): void => {
      window.removeEventListener("mousemove", move)
      window.removeEventListener("mouseup", up)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    window.addEventListener("mousemove", move)
    window.addEventListener("mouseup", up)
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize"
    document.body.style.userSelect = "none"
  }

  return (
    <div className={`split ${horizontal ? "row" : "col"}`} ref={ref}>
      <div className="split-cell" style={{ flexBasis: `${node.sizes[0]}%` }}>
        <RenderNode node={node.children[0]} project={project} theme={theme} canCloseRun={canCloseRun} />
      </div>
      <div className={`divider ${horizontal ? "v" : "h"}`} onMouseDown={onDown}>
        <span className="divider-grip" />
      </div>
      <div className="split-cell" style={{ flexBasis: `${node.sizes[1]}%` }}>
        <RenderNode node={node.children[1]} project={project} theme={theme} canCloseRun={canCloseRun} />
      </div>
    </div>
  )
}

const RenderNode = ({
  node,
  project,
  theme,
  canCloseRun
}: {
  node: LayoutNode | null
  project: ProjectWithState
  theme: string
  canCloseRun: boolean
}) => {
  const pane = useTerminals((s) => (node !== null && node.type === "pane" ? s.panes[node.paneId] : undefined))
  if (node === null) return null
  if (node.type === "pane") {
    if (pane === undefined) return null
    // "Keep at least one terminal" protects the RUN pane — the project's own
    // output, which the pane grid exists to show. A command's terminal, and a
    // shell's, are transient things and must always be closable: being the last
    // pane left used to hide the X, which stranded the pane, and a command's
    // pill with it.
    return (
      <TerminalPane
        pane={pane}
        project={project}
        theme={theme}
        canClose={pane.kind !== "run" || canCloseRun}
      />
    )
  }
  return <SplitContainer node={node} project={project} theme={theme} canCloseRun={canCloseRun} />
}

export const TerminalArea = ({ project, theme }: { project: ProjectWithState; theme: string }) => {
  const layouts = useTerminals((s) => s.layouts)
  const layout = layouts[project.id] ?? null
  const panes = useTerminals((s) => s.panes)
  const fullscreen = useTerminals((s) => s.fullscreen)
  const openPane = useTerminals((s) => s.openPane)
  // The collapse is the UI store's, not this component's — see `terminalsOpen`.
  const terminalsOpen = useUi((s) => s.terminalsOpen)
  const setTerminalsOpen = useUi((s) => s.setTerminalsOpen)

  const ensureRunSession = useEngine((s) => s.ensureRunSession)
  const openShell = useEngine((s) => s.openShell)
  const revealTerminals = useUi((s) => s.revealTerminals)
  const regionRef = useRef<HTMLDivElement | null>(null)
  const [quick, setQuick] = useState<HTMLElement | null>(null)
  const [opening, setOpening] = useState(false)
  /** Where the column was when a pane was zoomed, so exiting can put it back. */
  const returnTo = useRef<number | null>(null)

  const shown = collectPaneIds(layout)

  // Open a shell and tile it. The pane is created only after the call returns,
  // because the engine mints the session id this pane is named after — there is
  // no stable id to open a placeholder under, and a shell that failed to spawn
  // should leave no tile behind.
  const newShell = async (): Promise<void> => {
    revealTerminals()
    setOpening(true)
    try {
      // Provisional geometry; the pane re-negotiates via pty.resize once xterm
      // has measured its container.
      const session = await openShell(project.id, 120, 32)
      if (session === null) return
      // The engine bridged this session during the call — claim it so the pane
      // subscribes instead of attaching a second pump and doubling every byte.
      expectSelfBridged(session.sessionId)
      const nth = Object.values(panes).filter(
        (p) => p.projectId === project.id && p.kind === "shell"
      ).length
      openPane({
        paneId: shellPaneId(session.sessionId),
        projectId: project.id,
        kind: "shell",
        title: nth === 0 ? "shell" : `shell ${nth + 1}`,
        // The directory is the useful half of what makes this shell different
        // from any other; the environment cannot be put in a tooltip.
        subtitle: project.root,
        sessionId: session.sessionId
      })
    } finally {
      setOpening(false)
    }
  }

  // The supervised process always gets a pane — it is the project's main
  // terminal. Its session id changes on every (re)start, so it is re-resolved
  // whenever the FSM state moves.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const sessionId = await ensureRunSession(project.id).catch(() => null)
      if (cancelled) return
      openPane({
        paneId: runPaneId(project.id),
        projectId: project.id,
        kind: "run",
        title: project.name,
        subtitle: commandLine(project),
        sessionId
      })
    })()
    return () => {
      cancelled = true
    }
  }, [project.id, project.name, project.state, ensureRunSession, openPane])

  // Surfaces outlive their components by design, so something has to decide when
  // one is really finished. That is "no layout tiles this pane any more" —
  // across every project, so switching projects keeps their terminals warm.
  useEffect(() => {
    const live = new Set<string>()
    for (const l of Object.values(layouts)) for (const id of collectPaneIds(l ?? null)) live.add(id)
    sweepHosts(live)
  }, [layouts])

  const fullPane = fullscreen === null ? undefined : panes[fullscreen]
  const zoomed = fullPane !== undefined && fullPane.projectId === project.id

  // The overlay is `position: absolute; inset: 0` against the detail column,
  // and an absolutely positioned child of a scroll container is anchored to the
  // TOP of that container's content — it scrolls with the page rather than
  // covering the viewport. Fullscreening from a page scrolled down to the
  // terminals therefore opened it somewhere above the fold. Take the column to
  // the overlay, and give the reader their place back when it closes: landing
  // at the top of the project after exiting is the same problem in reverse.
  useEffect(() => {
    const scroller = regionRef.current?.closest(".main")
    if (!(scroller instanceof HTMLElement)) return
    const to = zoomed ? 0 : returnTo.current
    returnTo.current = zoomed ? scroller.scrollTop : null
    if (to === null) return
    // Instant, not smooth: zooming a pane empties the tile it came from, so the
    // column reflows in the same commit — a smooth scroll gets clamped by the
    // height it is animating through and stops short of the overlay.
    scroller.scrollTo({ top: to, behavior: "instant" })
  }, [zoomed])

  return (
    <div className="term-region" ref={regionRef}>
      {/* Collapsible like Environment, Commands and Runtime — the terminals are
          the tallest thing on the page and not always what you came for.
          Collapsing HIDES them; it does not close them. The panes stay mounted
          inside the collapsed body and their surfaces stay in the host
          registry, so reopening shows the same scrollback rather than
          re-attaching to a stream that has moved on. */}
      <CollapsibleCard
        id={`terminals-${project.id}`}
        icon={<Icons.Terminal size={14} />}
        title="Terminals"
        head={<span className="term-bar-count">{shown.length} open</span>}
        // The same picker the Commands card and every project card carry, in the
        // place a terminal actually comes from. Running something IS how a
        // terminal opens (there is no "new terminal" button, and there should
        // not be — it would be a window onto nothing), so the control that runs
        // things belongs on the card that shows them.
        actions={
          <>
            {/* Beside the command picker, not inside it: the picker is shared
                with every project card on the board, and a shell is only worth
                opening on the project you are looking at. */}
            <button
              className="card-quick"
              title="New shell — $SHELL in this project's directory and environment"
              disabled={opening}
              onClick={() => void newShell()}
            >
              <Icons.Terminal size={11} />
              <Icons.Plus size={10} sw={2.4} />
            </button>
            <button
              className="card-quick"
              title="Start or stop a command"
              onClick={(e) => {
                const el = e.currentTarget
                setQuick((open) => (open === null ? el : null))
              }}
            >
              <Icons.Play size={10} />
              <Icons.ChevronDown size={10} sw={2.4} />
            </button>
            {quick !== null && (
              <QuickMenu project={project} trigger={quick} onClose={() => setQuick(null)} />
            )}
          </>
        }
        open={terminalsOpen}
        onOpenChange={setTerminalsOpen}
      >
        {layout === null ? (
          <div className="term-empty">No terminals open</div>
        ) : (
          <div className="term-grid">
            <RenderNode node={layout} project={project} theme={theme} canCloseRun={shown.length > 1} />
          </div>
        )}
      </CollapsibleCard>

      {zoomed && fullPane !== undefined && (
        <div className="term-fullscreen">
          <TerminalPane pane={fullPane} project={project} theme={theme} fullscreen canClose={false} />
        </div>
      )}
    </div>
  )
}
