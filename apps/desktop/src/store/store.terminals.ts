import { create } from "zustand"
import type { ProjectId, SessionId } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// The tiling layout. A binary tree of splits per project, exactly as the design
// models it — drag a pane onto an edge to dock it, drag the divider to resize.
//
// A pane is a VIEW of an engine PTY session, never an owner of one: the session
// lives in the engine and survives pane close, page reload, and reconnect. That
// is why panes carry `sessionId` rather than any process handle.
// ────────────────────────────────────────────────────────────────────────────

export type SplitDir = "row" | "col"
export type DropSide = "left" | "right" | "top" | "bottom"

export type LayoutNode =
  | { readonly type: "pane"; readonly paneId: string }
  | {
      readonly type: "split"
      readonly id: string
      readonly dir: SplitDir
      readonly sizes: readonly [number, number]
      readonly children: readonly [LayoutNode, LayoutNode]
    }

export interface Pane {
  readonly paneId: string
  readonly projectId: ProjectId
  /** `run` mirrors the supervised process; `command` is an on-demand task;
   *  `shell` is an ad-hoc $SHELL in the project's directory and resolved
   *  environment — the same spawn, with nothing saved in the catalog. */
  readonly kind: "run" | "command" | "shell"
  readonly title: string
  /** Subtitle — the command line being run. */
  readonly subtitle: string
  readonly sessionId: SessionId | null
  readonly commandName?: string
  readonly exited: boolean
  readonly exitCode: number | null
}

let nodeSeq = 0
const nextNodeId = (): string => `n${++nodeSeq}`

// —— pure tree ops ——

export const removePane = (node: LayoutNode | null, paneId: string): LayoutNode | null => {
  if (node === null) return null
  if (node.type === "pane") return node.paneId === paneId ? null : node
  const a = removePane(node.children[0], paneId)
  const b = removePane(node.children[1], paneId)
  if (a === null) return b
  if (b === null) return a
  return { ...node, children: [a, b] }
}

const insertBeside = (
  node: LayoutNode,
  targetPaneId: string,
  fresh: LayoutNode,
  dir: SplitDir,
  before: boolean
): LayoutNode => {
  if (node.type === "pane") {
    if (node.paneId !== targetPaneId) return node
    return {
      type: "split",
      id: nextNodeId(),
      dir,
      sizes: [50, 50],
      children: before ? [fresh, node] : [node, fresh]
    }
  }
  return {
    ...node,
    children: [
      insertBeside(node.children[0], targetPaneId, fresh, dir, before),
      insertBeside(node.children[1], targetPaneId, fresh, dir, before)
    ]
  }
}

const withSizes = (node: LayoutNode, splitId: string, sizes: readonly [number, number]): LayoutNode => {
  if (node.type === "pane") return node
  if (node.id === splitId) return { ...node, sizes }
  return {
    ...node,
    children: [withSizes(node.children[0], splitId, sizes), withSizes(node.children[1], splitId, sizes)]
  }
}

export const collectPaneIds = (node: LayoutNode | null, acc: Array<string> = []): Array<string> => {
  if (node === null) return acc
  if (node.type === "pane") {
    acc.push(node.paneId)
    return acc
  }
  collectPaneIds(node.children[0], acc)
  collectPaneIds(node.children[1], acc)
  return acc
}

// —— store ——

interface TerminalState {
  panes: Record<string, Pane>
  layouts: Record<string, LayoutNode | null>
  fullscreen: string | null
  dragPaneId: string | null
  dropTarget: { paneId: string; side: DropSide } | null

  openPane: (pane: Omit<Pane, "exited" | "exitCode">) => void
  closePane: (projectId: ProjectId, paneId: string) => void
  bindSession: (paneId: string, sessionId: SessionId) => void
  markExited: (sessionId: SessionId, exitCode: number | null) => void
  dock: (projectId: ProjectId, targetPaneId: string, side: DropSide) => void
  resize: (projectId: ProjectId, splitId: string, sizes: readonly [number, number]) => void
  setFullscreen: (paneId: string | null) => void
  setDrag: (paneId: string | null) => void
  setDropTarget: (t: { paneId: string; side: DropSide } | null) => void
}

export const runPaneId = (projectId: ProjectId): string => `run:${projectId}`
export const commandPaneId = (projectId: ProjectId, name: string): string => `cmd:${projectId}:${name}`
/** A shell pane is named after the session it was opened for, and only that.
 *  The other two ids are derived from something stable — the project, or the
 *  command's name — so re-running rebinds the pane that was already there. A
 *  shell has no such name: each one is its own terminal, several can be open at
 *  once, and none of them is a re-run of an earlier one. */
export const shellPaneId = (sessionId: SessionId): string => sessionId

export const useTerminals = create<TerminalState>()((set, get) => ({
  panes: {},
  layouts: {},
  fullscreen: null,
  dragPaneId: null,
  dropTarget: null,

  openPane: (pane) =>
    set((s) => {
      const existing = s.panes[pane.paneId]
      const layout = s.layouts[pane.projectId] ?? null
      const alreadyTiled = collectPaneIds(layout).includes(pane.paneId)

      // Re-opening a pane that is already on screen is a no-op beyond refreshing
      // its session binding — never a duplicate tile.
      //
      // A caller with NO session id must not erase the one the pane already has.
      // The run pane is re-opened on every state change, and a stopped project
      // reports no session — so stopping one used to null the pane's id while
      // its surface, and the output on it, stayed on screen: a terminal full of
      // text whose Clear was disabled, because the id Clear needs had just been
      // thrown away. A session outlives its process here exactly as it does in
      // the engine, where `run:` scrollback is kept and never reaped.
      const rebinding = pane.sessionId !== null
      const nextPane: Pane = existing
        ? {
            ...existing,
            ...pane,
            sessionId: pane.sessionId ?? existing.sessionId,
            // Only a real binding means "alive again". Without one the pane
            // keeps its exit, or a stopped project would read as running.
            exited: rebinding ? false : existing.exited,
            exitCode: rebinding ? null : existing.exitCode
          }
        : { ...pane, exited: false, exitCode: null }

      const node: LayoutNode = { type: "pane", paneId: pane.paneId }
      const nextLayout: LayoutNode =
        layout === null
          ? node
          : alreadyTiled
            ? layout
            : { type: "split", id: nextNodeId(), dir: "row", sizes: [62, 38], children: [layout, node] }

      return {
        panes: { ...s.panes, [pane.paneId]: nextPane },
        layouts: { ...s.layouts, [pane.projectId]: nextLayout }
      }
    }),

  // Closing forgets the pane, it does not merely untile it. The pane record WAS
  // left behind, which made `panes` and `layouts` two answers to "does this
  // terminal exist" — and anything reading the wrong one (the board's command
  // pills, say) kept showing terminals the user had already closed. One record,
  // one existence: gone from here is gone everywhere.
  closePane: (projectId, paneId) =>
    set((s) => {
      const panes = { ...s.panes }
      delete panes[paneId]
      return {
        panes,
        layouts: { ...s.layouts, [projectId]: removePane(s.layouts[projectId] ?? null, paneId) },
        fullscreen: s.fullscreen === paneId ? null : s.fullscreen
      }
    }),

  bindSession: (paneId, sessionId) =>
    set((s) => {
      const pane = s.panes[paneId]
      if (pane === undefined) return s
      return { panes: { ...s.panes, [paneId]: { ...pane, sessionId, exited: false, exitCode: null } } }
    }),

  markExited: (sessionId, exitCode) =>
    set((s) => {
      const entries = Object.entries(s.panes).filter(([, p]) => p.sessionId === sessionId)
      if (entries.length === 0) return s
      const panes = { ...s.panes }
      for (const [id, pane] of entries) panes[id] = { ...pane, exited: true, exitCode }
      return { panes }
    }),

  dock: (projectId, targetPaneId, side) => {
    const { dragPaneId } = get()
    if (dragPaneId === null || dragPaneId === targetPaneId) {
      set({ dragPaneId: null, dropTarget: null })
      return
    }
    set((s) => {
      const pruned = removePane(s.layouts[projectId] ?? null, dragPaneId)
      if (pruned === null) return { dragPaneId: null, dropTarget: null }
      const dir: SplitDir = side === "left" || side === "right" ? "row" : "col"
      const before = side === "left" || side === "top"
      return {
        layouts: {
          ...s.layouts,
          [projectId]: insertBeside(pruned, targetPaneId, { type: "pane", paneId: dragPaneId }, dir, before)
        },
        dragPaneId: null,
        dropTarget: null
      }
    })
  },

  resize: (projectId, splitId, sizes) =>
    set((s) => {
      const layout = s.layouts[projectId] ?? null
      if (layout === null) return s
      return { layouts: { ...s.layouts, [projectId]: withSizes(layout, splitId, sizes) } }
    }),

  setFullscreen: (paneId) => set({ fullscreen: paneId }),
  setDrag: (paneId) => set({ dragPaneId: paneId, dropTarget: paneId === null ? null : get().dropTarget }),
  setDropTarget: (t) => set({ dropTarget: t })
}))
