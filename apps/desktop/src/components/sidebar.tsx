import { useMemo, useState } from "react"
import { Collapsible } from "@westopp/react-collapsible"
import type { Group, ProjectId, ProjectKind, ProjectWithState, RuntimeState } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { SYSTEM_IDS } from "~/store/store.systems"
import { Icons } from "./icons"
import { ConfirmDialog } from "./forms/confirm"
import { GroupDialog } from "./forms/lazy"
import { ProjectCard } from "./project.card"
import { COLLAPSE_DURATION, formatUptime, Spinner, StatusFigure } from "./primitives"

// ────────────────────────────────────────────────────────────────────────────
// Two-level tree, as designed: kind buckets at the top, groups beneath.
// `kind` is the engine's own discriminant, and groups come from the groups
// table — nothing here is derived from naming conventions.
// ────────────────────────────────────────────────────────────────────────────

const BUCKETS: ReadonlyArray<{ kind: ProjectKind; label: string }> = [
  { kind: "process", label: "Projects" },
  { kind: "docker", label: "Containers" },
  { kind: "compose", label: "Compose Stacks" }
]

const UNGROUPED = "__ungrouped__"

/** A group's tally: how many are up, how many broke, out of how many there are.
 *  The two numerators are the whole reason to read a collapsed group at all —
 *  the total on its own never said whether anything was wrong. */
const tallyOf = (projects: ReadonlyArray<ProjectWithState>) => ({
  running: projects.filter((p) => p.state === "running").length,
  failed: projects.filter((p) => p.state === "crashed" || p.state === "errored").length,
  total: projects.length
})

const Tally = ({ projects }: { projects: ReadonlyArray<ProjectWithState> }) => {
  const { running, failed, total } = tallyOf(projects)
  return (
    <span
      className="section-count"
      title={`${running} running · ${failed} failed · ${total} total`}
    >
      <span className={running > 0 ? "tally-run" : ""}>{running}</span>
      <span className="tally-sep">•</span>
      <span className={failed > 0 ? "tally-bad" : ""}>{failed}</span>
      <span className="tally-of">/{total}</span>
    </span>
  )
}

interface Section {
  readonly key: string
  readonly title: string
  readonly projects: ReadonlyArray<ProjectWithState>
  /** The group row behind this section, when there is one. Absent for
   *  "Ungrouped" and for sections standing in for a group that no longer
   *  exists — neither can be renamed or deleted. */
  readonly group?: Group
}

const sectionsFor = (
  projects: ReadonlyArray<ProjectWithState>,
  groups: ReadonlyArray<Group>
): ReadonlyArray<Section> => {
  const byGroup = new Map<string, Array<ProjectWithState>>()
  for (const p of projects) {
    const key = p.groupSlug ?? UNGROUPED
    const bucket = byGroup.get(key)
    if (bucket === undefined) byGroup.set(key, [p])
    else bucket.push(p)
  }
  const titled = groups
    .filter((g) => byGroup.has(g.slug))
    .map<Section>((g) => ({ key: g.slug, title: g.title, projects: byGroup.get(g.slug) ?? [], group: g }))

  // A project may reference a group that no longer exists; never hide it.
  const orphaned = [...byGroup.keys()].filter(
    (k) => k !== UNGROUPED && !groups.some((g) => g.slug === k)
  )
  const orphanSections = orphaned.map<Section>((k) => ({ key: k, title: k, projects: byGroup.get(k) ?? [] }))
  const loose = byGroup.get(UNGROUPED)

  return [
    ...titled,
    ...orphanSections,
    ...(loose === undefined ? [] : [{ key: UNGROUPED, title: "Ungrouped", projects: loose }])
  ]
}

// ────────────────────────────────────────────────────────────────────────────
// A group's controls follow the same rule as a project's — Start when there is
// something to start, Stop when there is something to stop — with one deliberate
// exception: a MIXED group shows both, because "stop all" is exactly the reason
// you reach for a group control while half of it is already up.
// ────────────────────────────────────────────────────────────────────────────

const GroupTools = ({ projects }: { projects: ReadonlyArray<ProjectWithState> }) => {
  const start = useEngine((s) => s.start)
  const stop = useEngine((s) => s.stop)
  const pending = useEngine((s) => s.pending)

  const settled = projects.filter((p) => pending[p.id] === undefined && p.state !== "starting" && p.state !== "stopping")
  const runnable = settled.filter((p) => p.state !== "running")
  const stoppable = settled.filter((p) => p.state === "running")

  // Everything is mid-transition: keep the slot occupied so the header does not
  // reflow when it settles.
  if (settled.length === 0) {
    return (
      <button className="ico-primary busy" title="Transition in progress" disabled>
        <Spinner />
      </button>
    )
  }

  return (
    <>
      {runnable.length > 0 && (
        <button
          className="ico-primary success"
          title={`Start ${runnable.length} in group`}
          onClick={() => runnable.forEach((p) => void start(p.id))}
        >
          <Icons.Play size={18} />
        </button>
      )}
      {stoppable.length > 0 && (
        <button
          className="ico-primary danger"
          title={`Stop ${stoppable.length} in group`}
          onClick={() => stoppable.forEach((p) => void stop(p.id))}
        >
          <Icons.Stop size={18} />
        </button>
      )}
    </>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Systems — the infrastructure the projects run ON, not projects themselves:
// the engine this client is talking to, and the Docker daemon the containers
// need. Lives at the foot of the tree (parity with the old app's system group)
// instead of as pills in the titlebar, so status sits with everything else it
// governs. Caddy/tunnels will join here as those modules land.
// ────────────────────────────────────────────────────────────────────────────

/** The systems' start/stop control. Deliberately the same shape, size and slot
 *  as a project's `LifecycleButton`: Docker being up is not a different KIND of
 *  fact from a project being up, so it should not read as one. A transition
 *  fills the same slot with a spinner rather than swapping the control out. */
const SystemButton = ({
  state,
  startTitle,
  stopTitle,
  canStart = true,
  onStart,
  onStop
}: {
  state: RuntimeState
  startTitle: string
  stopTitle: string
  canStart?: boolean
  onStart: () => void
  onStop: () => void
}) => {
  if (state === "starting" || state === "stopping") {
    return (
      <button className="ico-primary busy" title={state === "starting" ? "Starting…" : "Stopping…"} disabled>
        <Spinner size={14} />
      </button>
    )
  }
  return state === "running" ? (
    <button className="ico-primary danger" title={stopTitle} onClick={onStop}>
      <Icons.Stop size={16} />
    </button>
  ) : (
    <button className="ico-primary success" title={startTitle} disabled={!canStart} onClick={onStart}>
      <Icons.Play size={16} />
    </button>
  )
}

/** A system's card. Same interaction contract as a project's — a click selects,
 *  the chevron opens the detail pane, a click in the rail switches the pane —
 *  because a system that could only be looked at was the one thing on the board
 *  with no way in. */
const SystemCard = ({
  id,
  name,
  icon,
  state,
  meta,
  active,
  open,
  openOnSelect,
  onSelect,
  onOpen,
  onToggleOpen,
  children
}: {
  id: ProjectId
  name: string
  icon: React.ReactNode
  state: RuntimeState
  meta: string
  active: boolean
  open: boolean
  openOnSelect: boolean
  onSelect: () => void
  onOpen: () => void
  onToggleOpen: () => void
  /** The system's own start/stop control. */
  children: React.ReactNode
}) => (
  <div className={`svc-cell ${active ? "active" : ""}`}>
    <div className="sys-row" onClick={openOnSelect ? onOpen : onSelect} role="button" tabIndex={0}>
      <span className="sys-icon">{icon}</span>
      <span className="svc-body">
        <span className="svc-name">{name}</span>
        <span className="svc-meta">
          {/* No failure detail: a system's reason lives in its own pane, and the
              glyph links there rather than offering a project's drawer. */}
          <StatusFigure state={state} size={14} />
          <span className="svc-chip trunc">{meta}</span>
        </span>
      </span>
      <span className="sys-actions" onClick={(e) => e.stopPropagation()}>
        {children}
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
    </div>
  </div>
)

const SystemsGroup = ({
  collapsed,
  onToggle,
  selectedId,
  openId,
  compact,
  onSelect,
  onOpen,
  onToggleOpen
}: {
  collapsed: boolean
  onToggle: () => void
  selectedId: ProjectId | null
  openId: ProjectId | null
  compact: boolean
  onSelect: (id: ProjectId) => void
  onOpen: (id: ProjectId) => void
  onToggleOpen: (id: ProjectId) => void
}) => {
  const status = useEngine((s) => s.status)
  const engine = useEngine((s) => s.engine)
  const daemon = useEngine((s) => s.daemon)
  const startDaemon = useEngine((s) => s.startDaemon)
  const stopDaemon = useEngine((s) => s.stopDaemon)
  const shutdownEngine = useEngine((s) => s.shutdownEngine)
  const [confirmShutdown, setConfirmShutdown] = useState(false)

  // Systems speak the same status vocabulary as projects — a running daemon is
  // as running as a running project, and reads the same: the figure for its
  // state, running/walking/at rest, and a dot only when something has failed.
  const engineState: RuntimeState = status === "open" ? "running" : status === "connecting" ? "starting" : "crashed"
  const dockerState: RuntimeState =
    daemon.state === "running"
      ? "running"
      : daemon.state === "starting"
        ? "starting"
        : daemon.state === "start_failed"
          ? "errored"
          : "idle"

  const engineUp = status === "open"
  const dockerUp = daemon.state === "running"

  return (
    <div className="parent-group">
      <button className="parent-head" onClick={onToggle}>
        {collapsed ? <Icons.ChevronRight size={11} sw={2} /> : <Icons.ChevronDown size={11} sw={2} />}
        <span>Systems</span>
        <span className="parent-count">{(engineUp ? 1 : 0) + (dockerUp ? 1 : 0)}</span>
      </button>

      <Collapsible id="bucket-systems" open={!collapsed} transitionDuration={COLLAPSE_DURATION} initialOpen>
        <div className="band-groups">
        <div className="sys-body">
          <SystemCard
            id={SYSTEM_IDS.engine}
            name="Engine"
            icon={<Icons.Cpu size={14} />}
            state={engineState}
            // Uptime, not the version: the version is a constant compiled into
            // the engine and never told anyone anything.
            meta={engineUp ? formatUptime(engine?.startedAt) : status}
            active={selectedId === SYSTEM_IDS.engine}
            open={openId === SYSTEM_IDS.engine}
            openOnSelect={compact}
            onSelect={() => onSelect(SYSTEM_IDS.engine)}
            onOpen={() => onOpen(SYSTEM_IDS.engine)}
            onToggleOpen={() => onToggleOpen(SYSTEM_IDS.engine)}
          >
            {/* Same control as a project: one slot, three states. Start is the
                one thing a renderer genuinely cannot do — the engine is what
                serves this page — so it is present and disabled rather than
                absent, with the reason on it. */}
            <SystemButton
              state={engineState}
              startTitle="Start the engine from a terminal — nothing in this window can"
              stopTitle="Shut down the engine"
              canStart={false}
              onStart={() => {}}
              onStop={() => setConfirmShutdown(true)}
            />
          </SystemCard>

          <SystemCard
            id={SYSTEM_IDS.docker}
            name="Docker"
            icon={<Icons.Docker size={14} />}
            state={dockerState}
            meta={daemon.state}
            active={selectedId === SYSTEM_IDS.docker}
            open={openId === SYSTEM_IDS.docker}
            openOnSelect={compact}
            onSelect={() => onSelect(SYSTEM_IDS.docker)}
            onOpen={() => onOpen(SYSTEM_IDS.docker)}
            onToggleOpen={() => onToggleOpen(SYSTEM_IDS.docker)}
          >
            <SystemButton
              state={dockerState}
              startTitle="Start Docker"
              stopTitle="Stop Docker"
              onStart={() => void startDaemon()}
              onStop={() => void stopDaemon()}
            />
          </SystemCard>
        </div>
        </div>
      </Collapsible>

      {confirmShutdown && (
        <ConfirmDialog
          title="Shut down the engine?"
          confirmLabel="Shut down"
          danger
          onCancel={() => setConfirmShutdown(false)}
          onConfirm={() => {
            void shutdownEngine()
            setConfirmShutdown(false)
          }}
        >
          Every supervised project is stopped and this window loses its connection. Nothing here can start the
          engine again — you will need `pnpm engine` or the CLI.
        </ConfirmDialog>
      )}
    </div>
  )
}

interface Props {
  /** The highlighted card — where you are on the board. */
  readonly selectedId: ProjectId | null
  /** The project whose detail view is on screen, when there is one. */
  readonly openId: ProjectId | null
  readonly onSelect: (id: ProjectId) => void
  /** Show this project in the detail pane. Never closes it. */
  readonly onOpen: (id: ProjectId) => void
  readonly onToggleOpen: (id: ProjectId) => void
  readonly theme: string
  readonly onToggleTheme: () => void
  readonly onCollapse: () => void
  readonly onAddProject: () => void
  /** Drawn as the rail beside an open project rather than as the full board.
   *  Purely a scale change — same bands, groups, cards and controls. */
  readonly compact: boolean
  /** Give the fleet the whole window back. Only reachable while compact. */
  readonly onExpand: () => void
}

export const Sidebar = ({
  selectedId,
  openId,
  onSelect,
  onOpen,
  onToggleOpen,
  theme,
  onToggleTheme,
  onCollapse,
  onAddProject,
  compact,
  onExpand
}: Props) => {
  const projects = useEngine((s) => s.projects)
  const groups = useEngine((s) => s.groups)
  const resources = useEngine((s) => s.resources)
  const status = useEngine((s) => s.status)

  const removeGroup = useEngine((s) => s.removeGroup)

  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [bucketCollapsed, setBucketCollapsed] = useState<Record<string, boolean>>({})
  const [editingGroup, setEditingGroup] = useState<Group | "new" | null>(null)
  const [deletingGroup, setDeletingGroup] = useState<Group | null>(null)

  const matching = useMemo(
    () => projects.filter((p) => query === "" || p.name.toLowerCase().includes(query.toLowerCase())),
    [projects, query]
  )

  const buckets = BUCKETS.map((b) => ({
    ...b,
    sections: sectionsFor(
      matching.filter((p) => p.kind === b.kind),
      groups
    )
  })).filter((b) => b.sections.length > 0)

  const sectionKeys = buckets.flatMap((b) => b.sections.map((s) => `${b.kind}:${s.key}`))
  const allCollapsed = sectionKeys.length > 0 && sectionKeys.every((k) => collapsed[k] === true)
  const toggleAll = (): void =>
    setCollapsed(Object.fromEntries(sectionKeys.map((k) => [k, !allCollapsed])))

  /** Shut everything except one group — its own band stays open because the
   *  group lives inside it, and every other band, including Systems, goes.
   *  The board is the whole window now, so "just show me this one" is the
   *  cheapest way to get a long catalog out of the way. */
  const focusSection = (kind: string, key: string): void => {
    setCollapsed(Object.fromEntries(sectionKeys.map((k) => [k, k !== `${kind}:${key}`])))
    setBucketCollapsed({
      ...Object.fromEntries(BUCKETS.map((b) => [b.kind, b.kind !== kind])),
      systems: true
    })
  }

  const running = projects.filter((p) => p.state === "running").length
  const totalRss = Object.values(resources).reduce((a, s) => a + s.rssBytes, 0)

  return (
    <aside className="sidebar">
      <div className="side-top">
        <div className="workspace-pill">
          <span className="ws-avatar">
            <Icons.FolderOpen size={13} />
          </span>
          <span className="ws-name">matisa</span>
        </div>
        <div className="side-top-tools">
          {/* The way back. Without it the full board is reachable only before
              the first project is opened. */}
          {compact && (
            <button className="ico-btn" title="Show all projects  esc" onClick={onExpand}>
              <Icons.Grid size={14} />
            </button>
          )}
          <button className="ico-btn" title={allCollapsed ? "Expand all" : "Collapse all"} onClick={toggleAll}>
            {allCollapsed ? <Icons.ExpandAll size={14} /> : <Icons.CollapseAll size={14} />}
          </button>
          <button className="ico-btn" title="Toggle theme" onClick={onToggleTheme}>
            {theme === "dark" ? <Icons.Sun size={14} /> : <Icons.Moon size={14} />}
          </button>
          <button className="ico-btn" title="New group" onClick={() => setEditingGroup("new")}>
            <Icons.FolderPlus size={14} />
          </button>
          <button className="ico-btn" title="Add project" onClick={onAddProject}>
            <Icons.Plus size={14} />
          </button>
          {/* Only meaningful once there is a detail pane to give the width to —
              on the full board there is nothing to collapse into. */}
          {compact && (
            <button className="ico-btn" title="Hide project list" onClick={onCollapse}>
              <Icons.PanelLeft size={14} />
            </button>
          )}
        </div>

        {/* On the board this sits on the title's line; at rail width there is
            no room for both, and it wraps to a line of its own. */}
        <div className="search-wrap">
          <Icons.Search size={13} />
          <input placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <div className="side-list scroll">
        {buckets.map((bucket) => (
          <div key={bucket.kind} className="parent-group">
            <button
              className="parent-head"
              onClick={() => setBucketCollapsed((c) => ({ ...c, [bucket.kind]: !c[bucket.kind] }))}
            >
              {bucketCollapsed[bucket.kind] === true ? (
                <Icons.ChevronRight size={11} sw={2} />
              ) : (
                <Icons.ChevronDown size={11} sw={2} />
              )}
              <span>{bucket.label}</span>
              <span className="parent-count">{bucket.sections.reduce((a, s) => a + s.projects.length, 0)}</span>
            </button>

            <Collapsible
              id={`bucket-${bucket.kind}`}
              open={bucketCollapsed[bucket.kind] !== true}
              transitionDuration={COLLAPSE_DURATION}
              initialOpen
            >
              {/* The rule that ties a band's groups back to its title. */}
              <div className="band-groups">
              {bucket.sections.map((section) => {
                const key = `${bucket.kind}:${section.key}`
                const expanded = collapsed[key] !== true
                return (
                  // The group IS the container: hovering anywhere on it — head
                  // or any project inside — lifts the whole thing, so which
                  // projects belong to which group is never in question.
                  <div key={key} className={`section ${expanded ? "open" : ""}`}>
                    <div
                      className="section-head"
                      onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
                      role="button"
                      tabIndex={0}
                    >
                      <span className="caret">
                        {expanded ? <Icons.ChevronDown size={11} sw={2} /> : <Icons.ChevronRight size={11} sw={2} />}
                      </span>
                      <span className="section-title">{section.title}</span>
                      <Tally projects={section.projects} />
                      {/* Beside the tally, on hover: collapse everything that
                          is not this group. */}
                      <button
                        className="section-focus"
                        title={`Show only ${section.title}`}
                        aria-label={`Show only ${section.title}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          focusSection(bucket.kind, section.key)
                        }}
                      >
                        <Icons.Focus size={12} />
                      </button>
                      {/* No per-project dots on a collapsed group. The tally
                          beside the title already says how many there are and
                          how many are up; a second, coarser rendering of the
                          same two numbers was noise at every width, and at rail
                          width it was noise with nowhere to sit. */}
                      <span className="section-spacer" />
                      <span className="section-tools" onClick={(e) => e.stopPropagation()}>
                        {/* Rename/delete belong to a real group row. "Ungrouped"
                            is a rendering of the projects with no group, not a
                            thing that can be edited. */}
                        {section.group !== undefined && (
                          <span className="section-edit">
                            <button
                              className="ico"
                              title={`Rename ${section.title}`}
                              onClick={() => setEditingGroup(section.group ?? null)}
                            >
                              <Icons.Edit size={12} />
                            </button>
                            <button
                              className="ico danger-hover"
                              title={`Delete ${section.title}`}
                              onClick={() => setDeletingGroup(section.group ?? null)}
                            >
                              <Icons.Trash size={12} />
                            </button>
                          </span>
                        )}
                        <GroupTools projects={section.projects} />
                      </span>
                    </div>

                    <Collapsible
                      id={`group-${key}`}
                      open={expanded}
                      transitionDuration={COLLAPSE_DURATION}
                      initialOpen
                    >
                      <div className="section-body">
                        {section.projects.map((p) => (
                          <ProjectCard
                            key={p.id}
                            project={p}
                            active={selectedId === p.id}
                            open={openId === p.id}
                            openOnSelect={compact}
                            onSelect={() => onSelect(p.id)}
                            onOpen={() => onOpen(p.id)}
                            onToggleOpen={() => onToggleOpen(p.id)}
                          />
                        ))}
                      </div>
                    </Collapsible>
                  </div>
                )
              })}
              </div>
            </Collapsible>
          </div>
        ))}

        {/* The board is the whole window when nothing is selected, so what the
            index route used to say — no engine, no projects, nothing matching —
            is said here, where the projects would be. */}
        {buckets.length === 0 && (
          <div className="board-empty">
            {status !== "open" ? (
              <>
                <span className="board-empty-title">No engine</span>
                <span className="board-empty-sub">ws://127.0.0.1:4127 — run `pnpm engine`</span>
              </>
            ) : projects.length === 0 ? (
              <>
                <span className="board-empty-title">No projects yet</span>
                <span className="board-empty-sub">add one with the + above</span>
              </>
            ) : (
              <>
                <span className="board-empty-title">Nothing matches</span>
                <span className="board-empty-sub">try another search</span>
              </>
            )}
          </div>
        )}

        <SystemsGroup
          collapsed={bucketCollapsed["systems"] === true}
          onToggle={() => setBucketCollapsed((c) => ({ ...c, systems: !c["systems"] }))}
          selectedId={selectedId}
          openId={openId}
          compact={compact}
          onSelect={onSelect}
          onOpen={onOpen}
          onToggleOpen={onToggleOpen}
        />
      </div>

      <div className="side-foot">
        <span className="foot-dot" />
        <span className="foot-text">
          {running} running · {projects.length - running} stopped
        </span>
        <span className="foot-spacer" />
        <span className="foot-mem">{(totalRss / (1024 * 1024 * 1024)).toFixed(1)} GB</span>
      </div>

      {editingGroup !== null && (
        <GroupDialog
          {...(editingGroup === "new" ? {} : { existing: editingGroup })}
          onClose={() => setEditingGroup(null)}
        />
      )}

      {deletingGroup !== null && (
        <ConfirmDialog
          title={`Delete ${deletingGroup.title}?`}
          confirmLabel="Delete group"
          danger
          onCancel={() => setDeletingGroup(null)}
          onConfirm={() => {
            void removeGroup(deletingGroup.slug)
            setDeletingGroup(null)
          }}
        >
          {(() => {
            const members = projects.filter((p) => p.groupSlug === deletingGroup.slug).length
            return members === 0
              ? "The group is empty. Nothing else changes."
              : `${members} project${members === 1 ? "" : "s"} will move to Ungrouped. Nothing is deleted or stopped.`
          })()}
        </ConfirmDialog>
      )}
    </aside>
  )
}
