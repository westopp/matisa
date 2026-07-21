import { useEffect, useRef } from "react"
import type { ProjectWithState } from "@matisa/core"
import { useCommandRunner } from "~/hooks/use-command-run"
import { useProjectCommands } from "~/hooks/use-project-commands"
import { useEngine } from "~/store/store.engine"
import {
  collectPaneIds,
  commandPaneId,
  runPaneId,
  useTerminals,
  type LayoutNode
} from "~/store/store.terminals"
import { Icons } from "../icons"
import { commandLine } from "../primitives"
import { TerminalPane } from "./terminal.pane"

// ────────────────────────────────────────────────────────────────────────────
// The tiling shell: renders the split tree, hosts the divider drag, and owns
// the "add terminal" affordance (named commands become panes on demand).
// ────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

const SplitContainer = ({
  node,
  project,
  theme,
  canClose
}: {
  node: Extract<LayoutNode, { type: "split" }>
  project: ProjectWithState
  theme: string
  canClose: boolean
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
        <RenderNode node={node.children[0]} project={project} theme={theme} canClose={canClose} />
      </div>
      <div className={`divider ${horizontal ? "v" : "h"}`} onMouseDown={onDown}>
        <span className="divider-grip" />
      </div>
      <div className="split-cell" style={{ flexBasis: `${node.sizes[1]}%` }}>
        <RenderNode node={node.children[1]} project={project} theme={theme} canClose={canClose} />
      </div>
    </div>
  )
}

const RenderNode = ({
  node,
  project,
  theme,
  canClose
}: {
  node: LayoutNode | null
  project: ProjectWithState
  theme: string
  canClose: boolean
}) => {
  const pane = useTerminals((s) => (node !== null && node.type === "pane" ? s.panes[node.paneId] : undefined))
  if (node === null) return null
  if (node.type === "pane") {
    if (pane === undefined) return null
    return <TerminalPane pane={pane} project={project} theme={theme} canClose={canClose} />
  }
  return <SplitContainer node={node} project={project} theme={theme} canClose={canClose} />
}

export const TerminalArea = ({ project, theme }: { project: ProjectWithState; theme: string }) => {
  const layout = useTerminals((s) => s.layouts[project.id] ?? null)
  const panes = useTerminals((s) => s.panes)
  const fullscreen = useTerminals((s) => s.fullscreen)
  const openPane = useTerminals((s) => s.openPane)

  const commands = useProjectCommands(project.id)
  const ensureRunSession = useEngine((s) => s.ensureRunSession)
  const { run } = useCommandRunner(project.id)

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

  const available = commands.filter((c) => !shown.includes(commandPaneId(project.id, c.name)))
  const fullPane = fullscreen === null ? undefined : panes[fullscreen]

  return (
    <div className="term-region">
      <div className="term-bar">
        <span className="term-bar-title">
          <Icons.Terminal size={13} /> Terminals
        </span>
        <span className="term-bar-count">{shown.length} open</span>
        <span className="term-spacer" />
        {available.map((c) => (
          <button key={c.name} className="term-add" onClick={() => void run(c.name, c.command)} title={c.command}>
            <Icons.Plus size={13} /> {c.name}
          </button>
        ))}
      </div>

      {layout === null ? (
        <div className="term-empty">No terminals open</div>
      ) : (
        <div className="term-grid">
          <RenderNode node={layout} project={project} theme={theme} canClose={shown.length > 1} />
        </div>
      )}

      {fullPane !== undefined && fullPane.projectId === project.id && (
        <div className="term-fullscreen">
          <TerminalPane pane={fullPane} project={project} theme={theme} fullscreen canClose={false} />
        </div>
      )}
    </div>
  )
}
