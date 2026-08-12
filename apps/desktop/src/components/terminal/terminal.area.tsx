import { useEffect, useRef } from "react"
import type { ProjectWithState } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { collectPaneIds, runPaneId, useTerminals, type LayoutNode } from "~/store/store.terminals"
import { Icons } from "../icons"
import { CollapsibleCard } from "../panels"
import { commandLine } from "../primitives"
import { sweepHosts } from "./terminal.hosts"
import { TerminalPane } from "./terminal.pane"

// ────────────────────────────────────────────────────────────────────────────
// The tiling shell: renders the split tree and hosts the divider drag.
//
// There is deliberately no "open a terminal" control here. A terminal is the
// VIEW of a running process, so the only way to get one is to run something —
// the project itself, or a named command from the Commands card. A button that
// conjured an empty terminal would be offering a window onto nothing.
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
    // output, which the pane grid exists to show. A command's terminal is a
    // transient thing and must always be closable: being the last pane left
    // used to hide its X, which stranded it, and stranded its pill with it.
    return (
      <TerminalPane
        pane={pane}
        project={project}
        theme={theme}
        canClose={pane.kind === "command" || canCloseRun}
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

  const ensureRunSession = useEngine((s) => s.ensureRunSession)

  const shown = collectPaneIds(layout)

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

  return (
    <div className="term-region">
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
        defaultOpen
      >
        {layout === null ? (
          <div className="term-empty">No terminals open</div>
        ) : (
          <div className="term-grid">
            <RenderNode node={layout} project={project} theme={theme} canCloseRun={shown.length > 1} />
          </div>
        )}
      </CollapsibleCard>

      {fullPane !== undefined && fullPane.projectId === project.id && (
        <div className="term-fullscreen">
          <TerminalPane pane={fullPane} project={project} theme={theme} fullscreen canClose={false} />
        </div>
      )}
    </div>
  )
}
