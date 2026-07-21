import { useState } from "react"
import { Outlet, useNavigate, useParams } from "@tanstack/react-router"
import { Toaster } from "sonner"
import type { ProjectId } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { useUi } from "~/store/store.ui"
import { Icons } from "~/components/icons"
import { Sidebar } from "~/components/sidebar"
import { AddProjectDialog } from "~/components/forms/lazy"

// ────────────────────────────────────────────────────────────────────────────
// The window chrome: titlebar, sidebar, and the routed detail pane.
//
// The selected project lives in the URL, not in component state, so a reload
// lands back where you were and the terminals re-attach to the same sessions.
// ────────────────────────────────────────────────────────────────────────────

const Titlebar = () => {
  const status = useEngine((s) => s.status)
  const daemon = useEngine((s) => s.daemon)
  const engine = useEngine((s) => s.engine)
  const refreshCatalog = useEngine((s) => s.refreshCatalog)

  const theme = useUi((s) => s.theme)
  const toggleTheme = useUi((s) => s.toggleTheme)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const toggleSidebar = useUi((s) => s.toggleSidebar)

  const label = status === "open" ? `engine ${engine?.version ?? ""}`.trim() : status

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
        {daemon.state === "running" && (
          <span className="conn-pill open" title="Docker daemon is running">
            <Icons.Docker size={11} /> docker
          </span>
        )}
        <span className={`conn-pill ${status}`} title={status === "open" ? "Connected to the engine" : "No engine"}>
          {label}
        </span>
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
        <button
          className={`ico-btn ${sidebarCollapsed ? "" : "active"}`}
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          onClick={toggleSidebar}
        >
          <Icons.PanelLeft size={14} />
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
  const params = useParams({ strict: false }) as { projectId?: string }
  const selectedId = (params.projectId ?? null) as ProjectId | null

  return (
    <div className="desktop">
      <div className="window">
        <Titlebar />
        <div className="window-body">
          <div className={`sidebar-slot ${sidebarCollapsed ? "collapsed" : ""}`}>
            <Sidebar
              selectedId={selectedId}
              onSelect={(id) => void navigate({ to: "/project/$projectId", params: { projectId: id } })}
              theme={theme}
              onToggleTheme={toggleTheme}
              onCollapse={collapseSidebar}
              onAddProject={() => setAddingProject(true)}
            />
          </div>
          <Outlet />
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
