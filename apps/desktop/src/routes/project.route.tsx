import { lazy, Suspense, useState } from "react"
import { useParams } from "@tanstack/react-router"
import { useEngine } from "~/store/store.engine"
import { useUi } from "~/store/store.ui"
import { Icons } from "~/components/icons"
import { ProjectHero } from "~/components/hero"
import { CommandsCard, EnvironmentCard, FailuresCard } from "~/components/panels"
import { EditProjectDialog } from "~/components/forms/lazy"

// The terminal emulator is the heaviest dependency in the app and is reachable
// only from a project route — it must not sit on the first paint (CPERF-200).
const TerminalArea = lazy(() =>
  import("~/components/terminal/terminal.area").then((m) => ({ default: m.TerminalArea }))
)

// The project detail pane. Everything below the hero is engine-reported.

/** Docker/compose projects cannot start without the daemon. Say so, and offer
 *  the fix, rather than letting the start silently fail. */
const DaemonBanner = () => {
  const daemon = useEngine((s) => s.daemon)
  const startDaemon = useEngine((s) => s.startDaemon)
  if (daemon.state === "running") return null

  return (
    <div className="daemon-banner">
      <Icons.Docker size={15} />
      <span>
        Docker is {daemon.state === "start_failed" ? "not available" : daemon.state}
        {daemon.message === undefined ? "" : ` — ${daemon.message}`}
      </span>
      <button className="btn sm" disabled={daemon.state === "starting"} onClick={() => void startDaemon()}>
        {daemon.state === "starting" ? "Starting…" : "Start Docker"}
      </button>
    </div>
  )
}

export const ProjectRoute = () => {
  const { projectId } = useParams({ from: "/project/$projectId" })
  const project = useEngine((s) => s.projects.find((p) => p.id === projectId))
  const status = useEngine((s) => s.status)
  const theme = useUi((s) => s.theme)
  const [editing, setEditing] = useState(false)

  if (project === undefined) {
    return (
      <main className="main">
        <div className="empty-state">
          <div className="empty-state-inner">
            <Icons.Search size={22} />
            <span>{status === "open" ? "That project is no longer in the catalog." : "Waiting for the engine…"}</span>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="main">
      {(project.kind === "docker" || project.kind === "compose") && <DaemonBanner />}
      <ProjectHero project={project} onEdit={() => setEditing(true)} />
      <FailuresCard project={project} />
      {/* Configuration before output: what the project runs WITH is read far
          more often than the terminals are scrolled, and both collapse. */}
      <EnvironmentCard project={project} />
      <CommandsCard project={project} />
      <Suspense fallback={<div className="term-empty">Loading terminals…</div>}>
        <TerminalArea project={project} theme={theme} />
      </Suspense>
      {editing && <EditProjectDialog project={project} onClose={() => setEditing(false)} />}
    </main>
  )
}

export const IndexRoute = () => {
  const projects = useEngine((s) => s.projects)
  const status = useEngine((s) => s.status)

  return (
    <main className="main">
      <div className="empty-state">
        <div className="empty-state-inner">
          <Icons.Terminal size={26} />
          {status !== "open" ? (
            <>
              <span>No engine on ws://127.0.0.1:4127</span>
              <code className="metric-code">pnpm engine</code>
            </>
          ) : projects.length === 0 ? (
            <span>No projects yet — add one from the sidebar.</span>
          ) : (
            <span>Select a project.</span>
          )}
        </div>
      </div>
    </main>
  )
}
