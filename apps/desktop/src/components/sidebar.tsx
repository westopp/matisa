import { useMemo, useState } from "react"
import { Collapsible } from "@westopp/react-collapsible"
import type { Group, ProjectId, ProjectKind, ProjectWithState, RuntimeState } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { Icons } from "./icons"
import { ConfirmDialog } from "./forms/confirm"
import { GroupDialog } from "./forms/lazy"
import { ProjectCard } from "./project.card"
import { COLLAPSE_DURATION, formatUptime, Spinner, StatusDot, StatusFigure } from "./primitives"

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

const SystemsGroup = ({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) => {
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
        <div className="sys-body">
          <div className="sys-row">
            <span className="sys-icon">
              <Icons.Cpu size={14} />
            </span>
            <span className="svc-body">
              <span className="svc-name">Engine</span>
              <span className="svc-meta">
                <StatusFigure state={engineState} size={12} />
                {/* Uptime, not the version: the version is a constant compiled
                    into the engine and never told anyone anything. */}
                <span className="svc-port">{engineUp ? formatUptime(engine?.startedAt) : status}</span>
              </span>
            </span>
            {/* Same control as a project: one slot, three states. Start is the
                one thing a renderer genuinely cannot do — the engine is what
                serves this page — so it is present and disabled rather than
                absent, with the reason on it. */}
            <span className="sys-actions">
              <SystemButton
                state={engineState}
                startTitle="Start the engine from a terminal — nothing in this window can"
                stopTitle="Shut down the engine"
                canStart={false}
                onStart={() => {}}
                onStop={() => setConfirmShutdown(true)}
              />
            </span>
          </div>

          <div className="sys-row">
            <span className="sys-icon">
              <Icons.Docker size={14} />
            </span>
            <span className="svc-body">
              <span className="svc-name">Docker</span>
              <span className="svc-meta">
                <StatusFigure state={dockerState} size={12} />
                <span className="svc-port trunc">{daemon.state}</span>
              </span>
            </span>
            <span className="sys-actions">
              <SystemButton
                state={dockerState}
                startTitle="Start Docker"
                stopTitle="Stop Docker"
                onStart={() => void startDaemon()}
                onStop={() => void stopDaemon()}
              />
            </span>
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
  readonly selectedId: ProjectId | null
  readonly onSelect: (id: ProjectId) => void
  readonly theme: string
  readonly onToggleTheme: () => void
  readonly onCollapse: () => void
  readonly onAddProject: () => void
}

export const Sidebar = ({ selectedId, onSelect, theme, onToggleTheme, onCollapse, onAddProject }: Props) => {
  const projects = useEngine((s) => s.projects)
  const groups = useEngine((s) => s.groups)
  const resources = useEngine((s) => s.resources)

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
          <button className="ico-btn" title="Collapse sidebar" onClick={onCollapse}>
            <Icons.PanelLeft size={14} />
          </button>
        </div>
      </div>

      <div className="search-wrap">
        <Icons.Search size={13} />
        <input placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
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
                      <span className="section-count">{section.projects.length}</span>
                      {!expanded && (
                        <span className="section-dots">
                          {section.projects.slice(0, 5).map((p) => (
                            <StatusDot key={p.id} state={p.state} size={5} />
                          ))}
                          {section.projects.length > 5 && (
                            <span className="dots-more">+{section.projects.length - 5}</span>
                          )}
                        </span>
                      )}
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
                            onSelect={() => onSelect(p.id)}
                          />
                        ))}
                      </div>
                    </Collapsible>
                  </div>
                )
              })}
            </Collapsible>
          </div>
        ))}

        {buckets.length === 0 && (
          <div className="empty-row">{projects.length === 0 ? "No projects yet" : "No projects match"}</div>
        )}

        <SystemsGroup
          collapsed={bucketCollapsed["systems"] === true}
          onToggle={() => setBucketCollapsed((c) => ({ ...c, systems: !c["systems"] }))}
        />
        <div style={{ height: 24 }} />
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
