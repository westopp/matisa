import { useCallback, useEffect, useState } from "react"
import { Outlet, useNavigate, useParams } from "@tanstack/react-router"
import { Toaster } from "sonner"
import type { ProjectId } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { useUi } from "~/store/store.ui"
import { isSystemId } from "~/store/store.systems"
import { withTransition } from "~/lib/view-transition"
import { Icons } from "~/components/icons"
import { Banner } from "~/components/banner"
import { Sidebar } from "~/components/sidebar"
import { RightDrawer } from "~/components/drawer"
import { AddProjectDialog } from "~/components/forms/lazy"

// ────────────────────────────────────────────────────────────────────────────
// The window chrome and the three panes it frames: the fleet on the left, the
// routed detail pane in the middle, the inspector on the right. Each collapses,
// and that is the whole layout — there is no fourth mode.
//
// The board of project cards is not one either. Only the CENTRE pane has a
// width of its own; the fleet takes whatever is left. Collapse the centre and
// the fleet inherits the window, its container query trips, and the same cards
// reflow from a rail into the board. One state, two proportions.
//
// The selected project lives in the URL, not in component state, so a reload
// lands back where you were and the terminals re-attach to the same sessions.
// Collapsing the centre pane therefore means clearing the URL: "no project
// open" and "detail pane collapsed" are one fact, and storing it twice is how
// they drift.
// ────────────────────────────────────────────────────────────────────────────

const Titlebar = ({
  hasSelection,
  canReopen,
  onToggleDetail
}: {
  hasSelection: boolean
  /** There is a project to put back in the centre pane when it is expanded. */
  canReopen: boolean
  onToggleDetail: () => void
}) => {
  const refreshCatalog = useEngine((s) => s.refreshCatalog)
  const failureCount = useEngine((s) => s.failures.length)

  const theme = useUi((s) => s.theme)
  const toggleTheme = useUi((s) => s.toggleTheme)
  const fleetCollapsed = useUi((s) => s.fleetCollapsed)
  const toggleFleet = useUi((s) => s.toggleFleet)
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

        {/* The three panes, in the order they sit on screen. */}
        <span className="pane-toggles">
          {/* Collapsing the fleet with nothing in the centre would leave an
              empty window, so it is the one toggle with a precondition. */}
          <button
            className={`ico-btn ${fleetCollapsed || !hasSelection ? "" : "active"}`}
            title={
              hasSelection
                ? fleetCollapsed
                  ? "Show project list"
                  : "Hide project list"
                : "Open a project to hide the list"
            }
            disabled={!hasSelection}
            onClick={() => withTransition(toggleFleet)}
          >
            <Icons.PanelLeft size={14} />
          </button>
          <button
            className={`ico-btn ${hasSelection ? "active" : ""}`}
            title={
              hasSelection
                ? "Close the project — expand the board"
                : canReopen
                  ? "Reopen the last project"
                  : "Nothing to open yet"
            }
            disabled={!hasSelection && !canReopen}
            onClick={onToggleDetail}
          >
            <Icons.PanelCenter size={14} />
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
        </span>
      </div>
    </div>
  )
}

export const RootLayout = () => {
  const [addingProject, setAddingProject] = useState(false)
  const theme = useUi((s) => s.theme)
  const toggleTheme = useUi((s) => s.toggleTheme)
  const fleetCollapsed = useUi((s) => s.fleetCollapsed)
  const collapseFleet = useUi((s) => s.collapseFleet)

  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { projectId?: string; systemId?: string }
  // A system is addressed by its bare key in the URL and by its `sys:` id
  // everywhere else, so the two meet here.
  const selectedId = (params.projectId ??
    (params.systemId === undefined ? null : `sys:${params.systemId}`)) as ProjectId | null

  const focused = selectedId !== null

  // Highlight and route are two different things. Clicking a card moves the
  // highlight and nothing else; the card's chevron is what puts a project in
  // the URL. The highlight outlives the route, so expanding back to the board
  // leaves the card you came from lit — a board that forgets makes you find
  // your place again every time. It is also what the centre pane's toggle
  // reopens, which is what makes that toggle a toggle rather than a close
  // button that cannot undo itself.
  const [highlighted, setHighlighted] = useState<ProjectId | null>(selectedId)
  useEffect(() => {
    if (selectedId !== null) setHighlighted(selectedId)
  }, [selectedId])

  // Every route change that moves the layout asks the router to wrap its commit
  // in a view transition — a navigation lands asynchronously, and this is the
  // only place that can capture the before and after around it.
  const expand = useCallback((): void => void navigate({ to: "/", viewTransition: true }), [navigate])

  const open = useCallback(
    (id: ProjectId): void => {
      setHighlighted(id)
      if (isSystemId(id))
        void navigate({ to: "/system/$systemId", params: { systemId: id.slice(4) }, viewTransition: true })
      else void navigate({ to: "/project/$projectId", params: { projectId: id }, viewTransition: true })
    },
    [navigate]
  )

  // The chevron is a toggle: on the project already open it closes the pane.
  const toggleOpen = useCallback(
    (id: ProjectId): void => {
      if (id === selectedId) {
        setHighlighted(id)
        expand()
        return
      }
      open(id)
    },
    [expand, open, selectedId]
  )

  // The centre pane's own control. Collapsed, it puts back whatever was last
  // highlighted; there is nothing else it could mean.
  const toggleDetail = useCallback((): void => {
    if (focused) {
      expand()
      return
    }
    if (highlighted !== null) open(highlighted)
  }, [expand, focused, highlighted, open])

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
        <Titlebar hasSelection={focused} canReopen={highlighted !== null} onToggleDetail={toggleDetail} />
        {/* Above the panes, not inside one: the conditions it reports (no
            engine, no Docker) disable every pane at once, so it cannot belong
            to any of them. It occupies no height when there is nothing to say. */}
        <Banner />
        <div className="window-body">
          {/* `inert`, not `visibility: hidden`: both take the rail's controls
              out of the tab order, but an invisible element is not captured for
              a view transition, so the pane would vanish rather than slide
              shut. */}
          <div className={`fleet ${focused && fleetCollapsed ? "collapsed" : ""}`} inert={focused && fleetCollapsed}>
            <Sidebar
              selectedId={highlighted}
              openId={selectedId}
              onSelect={setHighlighted}
              onOpen={open}
              onToggleOpen={toggleOpen}
              theme={theme}
              onToggleTheme={toggleTheme}
              onCollapse={() => withTransition(collapseFleet)}
              onAddProject={() => setAddingProject(true)}
              compact={focused}
              onExpand={expand}
            />
          </div>
          {/* The centre pane's width is what drives the whole layout: the fleet
              takes the remainder, so one basis moves both. */}
          <div
            className={`pane-wrap ${focused ? (fleetCollapsed ? "solo" : "open") : ""}`}
            aria-hidden={!focused}
          >
            <Outlet />
          </div>
          {/* Overlaid, not docked: the inspector is absolutely positioned inside
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
