import { useCallback, useEffect, useState } from "react"
import { Outlet, useNavigate, useParams } from "@tanstack/react-router"
import { Toaster } from "sonner"
import type { ProjectId } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { useUi } from "~/store/store.ui"
import { isSystemId } from "~/store/store.systems"
import { Icons } from "~/components/icons"
import { Sidebar } from "~/components/sidebar"
import { RightDrawer } from "~/components/drawer"
import { AddProjectDialog } from "~/components/forms/lazy"

// ────────────────────────────────────────────────────────────────────────────
// The window chrome: titlebar, sidebar, and the routed detail pane.
//
// The selected project lives in the URL, not in component state, so a reload
// lands back where you were and the terminals re-attach to the same sessions.
// ────────────────────────────────────────────────────────────────────────────

const Titlebar = ({ hasSelection }: { hasSelection: boolean }) => {
  const refreshCatalog = useEngine((s) => s.refreshCatalog)
  const failureCount = useEngine((s) => s.failures.length)

  const theme = useUi((s) => s.theme)
  const toggleTheme = useUi((s) => s.toggleTheme)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const drawerOpen = useUi((s) => s.drawerOpen)
  const toggleDrawer = useUi((s) => s.toggleDrawer)

  // Engine + Docker status moved into the sidebar's Systems group — the titlebar
  // no longer mirrors them.
  return (
    <div className="titlebar">
      <div className="traffic">
        <span className="t-light close" />
        <span className="t-light min" />
        <span className="t-light max" />
      </div>
      <div className="title-text">
        <span className="brand">Matisa</span>
        <span className="brand-sub">·</span>
        <span className="title-sub">Local Services</span>
      </div>
      <div className="title-right">
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          <span className={`tt-knob ${theme}`}>
            {theme === "dark" ? <Icons.Moon size={12} /> : <Icons.Sun size={12} />}
          </span>
          <span className="tt-track" />
        </button>
        <button className="ico-btn" title="Refresh" onClick={() => void refreshCatalog()}>
          <Icons.Refresh size={14} />
        </button>
        {/* With nothing selected the fleet IS the view — there is no second
            column to give its width to, so the control says so rather than
            leaving the window empty. */}
        <button
          className={`ico-btn ${sidebarCollapsed || !hasSelection ? "" : "active"}`}
          title={
            hasSelection
              ? sidebarCollapsed
                ? "Show project list"
                : "Hide project list"
              : "Open a project to hide the list"
          }
          disabled={!hasSelection}
          onClick={toggleSidebar}
        >
          <Icons.PanelLeft size={14} />
        </button>
        {/* A crash that happened while you were elsewhere is the one thing the
            chrome must not stay silent about once its toast has gone. */}
        <button
          className={`ico-btn ${drawerOpen ? "active" : ""}`}
          title={drawerOpen ? "Hide inspector" : "Show inspector"}
          onClick={toggleDrawer}
        >
          <Icons.PanelRight size={14} />
          {failureCount > 0 && !drawerOpen && <span className="ico-badge" />}
        </button>
      </div>
    </div>
  )
}

export const RootLayout = () => {
  const [addingProject, setAddingProject] = useState(false)
  const theme = useUi((s) => s.theme)
  const toggleTheme = useUi((s) => s.toggleTheme)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const collapseSidebar = useUi((s) => s.collapseSidebar)

  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { projectId?: string; systemId?: string }
  // A system is addressed by its bare key in the URL and by its `sys:` id
  // everywhere else, so the two meet here.
  const selectedId = (params.projectId ??
    (params.systemId === undefined ? null : `sys:${params.systemId}`)) as ProjectId | null

  // One view, two proportions. With nothing selected the fleet is the whole
  // window and the routed pane renders nothing; selecting a project turns the
  // same fleet into a rail beside it. Nothing mounts or unmounts across the
  // change — the board reflows, the pane takes the rest of the width.
  const focused = selectedId !== null

  // Highlight and route are two different things now. Clicking a card moves the
  // highlight and nothing else; the card's chevron is what puts a project in
  // the URL. The highlight outlives the route, so expanding back to the board
  // leaves the card you came from lit — a board that forgets makes you find
  // your place again every time.
  const [highlighted, setHighlighted] = useState<ProjectId | null>(selectedId)
  useEffect(() => {
    if (selectedId !== null) setHighlighted(selectedId)
  }, [selectedId])

  const expand = useCallback((): void => void navigate({ to: "/" }), [navigate])

  const open = useCallback(
    (id: ProjectId): void => {
      setHighlighted(id)
      if (isSystemId(id)) void navigate({ to: "/system/$systemId", params: { systemId: id.slice(4) } })
      else void navigate({ to: "/project/$projectId", params: { projectId: id } })
    },
    [navigate]
  )

  // The chevron is a toggle: on the project already open it closes the pane.
  const toggleOpen = useCallback(
    (id: ProjectId): void => {
      if (id === selectedId) {
        setHighlighted(id)
        void navigate({ to: "/" })
        return
      }
      open(id)
    },
    [navigate, open, selectedId]
  )

  // Escape gives the fleet the window back, the way it does in the design.
  // Ignored while a dialog, a menu or a field has the focus — Escape belongs to
  // whatever is on top, and only reaches the layout when nothing else wants it.
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const el = document.activeElement
      if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      if (document.querySelector(".scrim, .menu") !== null) return
      expand()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [focused, expand])

  return (
    <div className="desktop">
      <div className="window">
        <Titlebar hasSelection={focused} />
        <div className="window-body">
          <div className={`fleet ${focused ? "as-rail" : ""} ${focused && sidebarCollapsed ? "hidden" : ""}`}>
            <Sidebar
              selectedId={highlighted}
              openId={selectedId}
              onSelect={setHighlighted}
              onOpen={open}
              onToggleOpen={toggleOpen}
              theme={theme}
              onToggleTheme={toggleTheme}
              onCollapse={collapseSidebar}
              onAddProject={() => setAddingProject(true)}
              compact={focused}
              onExpand={expand}
            />
          </div>
          <Outlet />
          {/* Overlaid, not docked: the drawer is absolutely positioned inside
              the body, so opening it never reflows the terminals. */}
          <RightDrawer selectedId={selectedId} />
        </div>
        {addingProject && <AddProjectDialog onClose={() => setAddingProject(false)} />}

        {/* Every engine failure surfaces here — the user is never left guessing
            why a project did not start (old-app parity). */}
        <Toaster
          theme={theme === "dark" ? "dark" : "light"}
          position="bottom-right"
          richColors
          closeButton
          toastOptions={{ style: { fontFamily: "var(--font-sans)" } }}
        />
      </div>
    </div>
  )
}
