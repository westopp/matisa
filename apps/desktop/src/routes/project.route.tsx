import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "@tanstack/react-router"
import { useEngine } from "~/store/store.engine"
import { useUi } from "~/store/store.ui"
import { Icons } from "~/components/icons"
import { ProjectHero } from "~/components/hero"
import { CommandsCard, EnvironmentCard } from "~/components/panels"
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
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)

  // A project removed from the catalog leaves this route pointing at nothing.
  // Fall back to the index rather than parking the user on a tombstone — but
  // only for a project this mount has actually SEEN. An empty catalog is the
  // normal state between connecting and the first `catalog.list`, and treating
  // that as a removal bounces every reload of a project route to the index.
  const seen = useRef(false)
  if (project !== undefined) seen.current = true

  useEffect(() => {
    if (seen.current && project === undefined) void navigate({ to: "/" })
  }, [project, navigate])

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
      {/* Failures moved to the inspector drawer — they are consulted after
          something goes wrong, and do not deserve permanent vertical space
          above the configuration that is read on every visit. */}
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

/** Nothing selected: the fleet board is the view and owns the whole window, so
 *  the routed pane draws nothing at all. What this used to say — no engine, no
 *  projects, pick one — is said by the board itself, where the projects are. */
export const IndexRoute = () => null
