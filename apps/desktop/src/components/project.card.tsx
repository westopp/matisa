import { useMemo, useState } from "react"
import { BASE_CONTEXT_ID, ContextId, type ProjectWithState } from "@matisa/core"
import { closeSession } from "~/rpc/rpc.pty"
import { useEngine } from "~/store/store.engine"
import { revealPath } from "~/store/store.picker"
import { openExternal } from "~/lib/native"
import { useCommandRunner, type CommandRunner } from "~/hooks/use-command-run"
import { cardName } from "~/lib/view-transition"
import { useLifecycleState } from "~/hooks/use-lifecycle-state"
import { useTerminals, type Pane } from "~/store/store.terminals"
import { Icons } from "./icons"
import { Menu, type MenuItem } from "./menu"
import { QuickMenu } from "./quick.commands"
import { ConfirmDialog } from "./forms/confirm"
import { EditProjectDialog } from "./forms/lazy"
import {
  CommandRestartButton,
  CommandRunButton,
  formatMB,
  KillButton,
  LifecycleButton,
  primaryPort,
  ProjectAvatar,
  StatusFigure,
  type FailureDetail
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

/** The commands chip — the same quick-select the detail view's Commands card
 *  carries, on the card itself: start or stop anything this project owns
 *  without opening it. The menu is mounted only while it is open, so the board
 *  does not fetch every project's commands to draw a chevron. */
const QuickChip = ({ project }: { project: ProjectWithState }) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <button
        className="svc-chip quick"
        title="Start or stop a command"
        onClick={(e) => {
          e.stopPropagation()
          const el = e.currentTarget
          setAnchor((open) => (open === null ? el : null))
        }}
      >
        <Icons.Play size={9} />
        <Icons.ChevronDown size={9} sw={2.4} />
      </button>
      {anchor !== null && (
        <QuickMenu project={project} trigger={anchor} onClose={() => setAnchor(null)} />
      )}
    </>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// The project's OTHER processes — the named commands with a terminal open
// beside the supervised one. One pill each, and the pills sit UNDER the card
// rather than inside it: they belong to the project, but they are not facts
// about it the way the port and the environment are.
//
// A pill is the card in miniature and says so with the same parts, not with
// look-alikes: the same status figure (running man, walking man, red dot,
// failure triangle with its reason tip and its reset), the same kill button,
// and the same run/stop control that shows a spinner while the session opens.
// A pill offering Stop for a command that already exited is the bug those
// shared components exist to prevent.
// ────────────────────────────────────────────────────────────────────────────

const CommandPill = ({
  project,
  pane,
  runner,
  onOpen
}: {
  project: ProjectWithState
  pane: Pane
  runner: CommandRunner
  /** Where the output is. A failed command's reason lives in its terminal, so
   *  the tip's second button goes there rather than to the project drawer,
   *  which knows nothing about commands. */
  onOpen: () => void
}) => {
  const closePane = useTerminals((s) => s.closePane)
  const name = pane.commandName ?? pane.title
  const status = runner.statusOf(name)
  const state = runner.stateOf(name)
  const running = status === "running"

  // The same close the terminal's own X performs, because it closes the same
  // thing: end the session — nothing else holds a handle on a command's pty —
  // then forget the pane, which takes this pill with it.
  const dismiss = (): void => {
    if (pane.sessionId !== null) closeSession(pane.sessionId)
    closePane(project.id, pane.paneId)
  }

  const failure: FailureDetail = {
    headline: "Command failed",
    body: pane.subtitle,
    reason: `${name} exited with ${pane.exitCode === null ? "a signal" : `code ${pane.exitCode}`}`,
    exit: pane.exitCode ?? "signal",
    // Dismissing the pill dismisses the terminal, because they are one thing:
    // the pill is that pane's summary, and a summary that outlives what it
    // summarises is the divergence this shares its state to prevent.
    resetTitle: "Dismiss — close this terminal and forget the failure",
    onReset: dismiss,
    details: { label: "Terminal", onClick: onOpen }
  }

  return (
    <span className="cmd-pill" title={pane.subtitle}>
      <StatusFigure state={state} size={14} dotSize={6} failure={failure} />
      <span className="cmd-pill-name">{name}</span>
      <span className="svc-controls">
        <KillButton
          enabled={running}
          onKill={() => runner.kill(name)}
          title="Kill this command — no interrupt, no waiting"
        />
        <CommandRestartButton
          enabled={running}
          onRestart={() => void runner.restart(name, pane.subtitle)}
        />
        <CommandRunButton
          status={status}
          onRun={() => void runner.run(name, pane.subtitle)}
          onStop={() => runner.stop(name)}
        />
      </span>
      {/* Out of the way until you reach for it — a pill is a status first. The
          same rule the terminal's X follows: it will not close on a live
          process, because that would strand something running with no window
          onto it. Stop or kill it first. */}
      <button
        className="cmd-pill-x"
        title={running ? "Stop or kill the command before closing" : "Close this command and its terminal"}
        aria-label="Close this command and its terminal"
        disabled={running}
        onClick={dismiss}
      >
        <Icons.X size={11} sw={2.4} />
      </button>
    </span>
  )
}

/** One pill per open command terminal — read straight off the pane records,
 *  which are now the single fact about whether a terminal exists. Deriving this
 *  from anything else (the layout tree, a filter on liveness) would be a second
 *  answer to that question, and a second answer is exactly how a pill outlives
 *  the terminal it summarises. */
const CommandPills = ({ project, onOpen }: { project: ProjectWithState; onOpen: () => void }) => {
  const panes = useTerminals((s) => s.panes)
  const runner = useCommandRunner(project.id)

  const open = useMemo(
    () => Object.values(panes).filter((p) => p.projectId === project.id && p.kind === "command"),
    [panes, project.id]
  )

  if (open.length === 0) return null

  return (
    <div className="cmd-pills">
      {open.map((pane) => (
        <CommandPill key={pane.paneId} project={project} pane={pane} runner={runner} onOpen={onOpen} />
      ))}
    </div>
  )
}

export const ProjectCard = ({
  project,
  active,
  open,
  openOnSelect,
  onSelect,
  onOpen,
  onToggleOpen
}: {
  project: ProjectWithState
  /** Highlighted — the card you last clicked. Not the same as opened. */
  active: boolean
  /** This project's detail view is the one on screen. */
  open: boolean
  /** A click on the card opens it. True in the rail, where a detail pane is
   *  already on screen: there, picking a card IS asking to see it. */
  openOnSelect: boolean
  onSelect: () => void
  onOpen: () => void
  onToggleOpen: () => void
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
            onSelect: () => openExternal(`http://localhost:${port}`)
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
    // One grid cell holds the card AND the command pills beneath it, so the two
    // travel together as the board reflows — the pills are the project's, but
    // they are not part of its card. The selection tone is declared here rather
    // than on the card, so the pills take the same fill: they are part of what
    // is selected, not grey satellites of it. No state class — the fill says
    // selected and nothing else.
    // Named for the view transition: the board and the rail are the same cards
    // at two widths, so the browser tweens each one from its grid slot to its
    // place in the column rather than crossfading the two layouts.
    <div
      className={`svc-cell ${active ? "active" : ""}`}
      style={{ viewTransitionName: cardName(project.id) }}
    >
    {/* The state rides on the card itself: a selected card is FILLED with the
        tone of what it is doing — lavender running, coral broken — and every
        chip and control inside it inverts onto that surface.
        On the board a click SELECTS and nothing else — the chevron is what opens
        a project, so you can point at one without losing the board. In the rail
        the detail pane is already open and a click switches it to this project:
        there is nothing to lose, and the extra click to the chevron would be
        pure ceremony. */}
    <div
      className={`svc-row st-${project.state} ${active ? "active" : ""} ${busy ? "busy" : ""}`}
      onClick={openOnSelect ? onOpen : onSelect}
      // The chevron is still the deliberate way in, but a double click is what
      // a list of things has always meant by "open this one" — and on the board,
      // where a single click only selects, it saves crossing the card to reach
      // the chevron. Never from a control inside the card: the buttons stop
      // clicks from selecting the row, and a fast second press on kill or start
      // must not be read as "open" either.
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("button")) onOpen()
      }}
      role="button"
      tabIndex={0}
    >
      {/* First line: artwork, name, controls. */}
      <span className="svc-mid">
        <ProjectAvatar project={project} size={15} className="svc-icon" />

        <span className="svc-body">
          <span className="svc-name">{project.name}</span>
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
            <Icons.More size={17} />
          </button>
        </span>
      </span>

      {/* Second line: the facts, one pill each — and the way in, at the end of
          it. The chevron sits OUTSIDE the strip: at rail width the strip
          scrolls sideways, and the one control that opens the project must not
          be able to scroll out of reach. */}
      <span className="svc-foot">
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
          <QuickChip project={project} />
          {/* The figure says running; only the port not answering needs words. */}
          {warmingUp && <span className="svc-health waiting">starting up</span>}
          {project.health === "timeout" && !warmingUp && (
            <span className="svc-health timeout">timeout</span>
          )}
        </span>

        <button
          className={`svc-open ${open ? "open" : ""}`}
          title={open ? "Close the detail view" : "Open the detail view"}
          aria-label={open ? "Close the detail view" : "Open the detail view"}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            onToggleOpen()
          }}
        >
          <Icons.ChevronRight size={15} sw={2.2} />
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

    {/* Under the card, not in it. */}
    <CommandPills project={project} onOpen={onOpen} />
    </div>
  )
}
