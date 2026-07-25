import { useState } from "react"
import { BASE_CONTEXT_ID, ContextId, type ProjectWithState } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { revealPath } from "~/store/store.picker"
import { useLifecycleState } from "~/hooks/use-lifecycle-state"
import { Icons } from "./icons"
import { Menu, type MenuItem } from "./menu"
import { ConfirmDialog } from "./forms/confirm"
import { EditProjectDialog } from "./forms/lazy"
import {
  formatMB,
  KillButton,
  LifecycleButton,
  primaryPort,
  ProjectAvatar,
  StatusFigure
} from "./primitives"

// ────────────────────────────────────────────────────────────────────────────
// The project card — one project, everywhere a list of them is drawn.
//
// Two lines beside the artwork: the name, then the facts as chips (status,
// port, resources, environment). Controls sit on the right in a fixed order —
// kill, start/stop, manage — and the order never changes, because a control
// that moves is a control you have to look for.
//
// The chips are the only things that come and go: a portless worker has no port
// chip rather than a chip saying it has no port, and resources appear when the
// engine has a sample to report. Nothing is drawn as an em-dash standing in for
// absence.
// ────────────────────────────────────────────────────────────────────────────

/** The environment chip. Immutable while the project is up: the vars were read
 *  at spawn, so switching now would show one environment and run another. The
 *  chip stays visible either way — which environment produced a running process
 *  is exactly what you want to know while it runs — it just stops being a
 *  button. */
const EnvChip = ({ project, locked }: { project: ProjectWithState; locked: boolean }) => {
  const contexts = useEngine((s) => s.contexts)
  const activateContext = useEngine((s) => s.activateContext)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const activeId = project.activeContextId ?? BASE_CONTEXT_ID
  const active = contexts.find((c) => c.id === activeId)
  const label = active?.name ?? "base"

  if (locked) {
    return (
      <span className="svc-chip env locked" title={`Running with "${label}" — stop to change it`}>
        {label}
      </span>
    )
  }

  const items: ReadonlyArray<MenuItem> = contexts.map((c) => ({
    key: c.id,
    label: c.name,
    note: `${c.vars.length}`,
    selected: c.id === activeId,
    onSelect: () => void activateContext(project.id, ContextId.make(c.id))
  }))

  return (
    <>
      <button
        className="svc-chip env"
        title={`Environment: ${label}`}
        onClick={(e) => {
          e.stopPropagation()
          const el = e.currentTarget
          setAnchor((open) => (open === null ? el : null))
        }}
      >
        {label}
        <Icons.ChevronDown size={9} sw={2.4} />
      </button>
      {anchor !== null && <Menu trigger={anchor} items={items} onClose={() => setAnchor(null)} />}
    </>
  )
}

export const ProjectCard = ({
  project,
  active,
  onSelect
}: {
  project: ProjectWithState
  active: boolean
  onSelect: () => void
}) => {
  const sample = useEngine((s) => s.resources[project.id])
  const kill = useEngine((s) => s.kill)
  const removeProject = useEngine((s) => s.removeProject)
  const { busy, running, warmingUp } = useLifecycleState(project)

  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)

  const port = primaryPort(project)
  // Alive or mid-transition. Both are states a kill is FOR: the second one more
  // than the first, since a stop that will not finish is the reason this button
  // exists at all.
  const killable = running || busy || project.state === "starting" || project.state === "stopping"

  const manage: ReadonlyArray<MenuItem> = [
    {
      key: "edit",
      label: "Edit project…",
      icon: <Icons.Edit size={13} />,
      // The dialog rewrites command, root and ports — the things a running
      // process was spawned from. Editing them mid-flight would leave the form
      // and the process describing different projects.
      disabled: busy,
      onSelect: () => setEditing(true)
    },
    ...(port === undefined
      ? []
      : [
          {
            key: "open",
            label: "Open in browser",
            icon: <Icons.Compass size={13} />,
            disabled: !running,
            onSelect: () => window.open(`http://localhost:${port}`, "_blank", "noopener")
          }
        ]),
    {
      key: "reveal",
      label: "Reveal in Finder",
      icon: <Icons.FolderOpen size={13} />,
      onSelect: () => void revealPath(project.root)
    },
    {
      key: "copy",
      label: "Copy path",
      icon: <Icons.Copy size={13} />,
      onSelect: () => void navigator.clipboard?.writeText(project.root)
    },
    {
      key: "remove",
      label: "Remove project…",
      icon: <Icons.Trash size={13} />,
      danger: true,
      onSelect: () => setRemoving(true)
    }
  ]

  return (
    <div
      className={`svc-row ${active ? "active" : ""} ${busy ? "busy" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
    >
      <ProjectAvatar project={project} className="svc-icon" />

      <span className="svc-body">
        <span className="svc-name">{project.name}</span>
        <span className="svc-meta">
          <StatusFigure state={project.state} projectId={project.id} />
          {port !== undefined && <span className="svc-chip">:{port}</span>}
          {/* Only while it runs. A stopped project reporting `0.0% • 0MB` is a
              measurement of nothing dressed up as a reading. */}
          {running && sample !== undefined && (
            <span className="svc-chip">
              {sample.cpuPercent.toFixed(1)}%<span className="chip-sep">•</span>
              {formatMB(sample.rssBytes)}MB
            </span>
          )}
          <EnvChip project={project} locked={running || busy || project.state === "stopping"} />
          {/* The figure says running; only the port not answering needs words. */}
          {warmingUp && <span className="svc-health waiting">starting up</span>}
          {project.health === "timeout" && !warmingUp && (
            <span className="svc-health timeout">timeout</span>
          )}
        </span>
      </span>

      <span className="svc-controls" onClick={(e) => e.stopPropagation()}>
        <KillButton enabled={killable} onKill={() => void kill(project.id)} />
        <LifecycleButton project={project} />
        <button
          className="ico"
          title="Manage project"
          onClick={(e) => {
            const el = e.currentTarget
            setMenu((open) => (open === null ? el : null))
          }}
        >
          <Icons.More size={15} />
        </button>
      </span>

      {menu !== null && <Menu trigger={menu} items={manage} onClose={() => setMenu(null)} />}

      {/* Both dialogs are React children of the row, so their clicks would
          otherwise bubble out and select the project underneath them. The
          wrapper exists only to catch that — `display: contents` keeps it from
          also becoming a flex item and stealing a gap from the controls. */}
      <span style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}>
        {editing && <EditProjectDialog project={project} onClose={() => setEditing(false)} />}

        {removing && (
          <ConfirmDialog
            title={`Remove ${project.name}?`}
            confirmLabel="Remove project"
            danger
            onCancel={() => setRemoving(false)}
            onConfirm={() => {
              setRemoving(false)
              void removeProject(project.id)
            }}
          >
            The catalog entry, its commands and its environment binding go. Nothing on disk is
            touched
            {running
              ? ", and the running process is left alone — stop it first if you want it down."
              : "."}
          </ConfirmDialog>
        )}
      </span>
    </div>
  )
}
