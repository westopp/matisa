import { useMemo, useState } from "react"
import { Collapsible } from "@westopp/react-collapsible"
import type { Group, ProjectId, ProjectKind, ProjectWithState } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { Icons } from "./icons"
import { intentLabel, useLifecycleState } from "~/hooks/use-lifecycle-state"
import {
  COLLAPSE_DURATION,
  formatMB,
  LifecycleButton,
  primaryPort,
  ProjectAvatar,
  Spinner,
  StatusDot
} from "./primitives"

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
    .map<Section>((g) => ({ key: g.slug, title: g.title, projects: byGroup.get(g.slug) ?? [] }))

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
        <Spinner size={12} />
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
          <Icons.Play size={14} />
        </button>
      )}
      {stoppable.length > 0 && (
        <button
          className="ico-primary danger"
          title={`Stop ${stoppable.length} in group`}
          onClick={() => stoppable.forEach((p) => void stop(p.id))}
        >
          <Icons.Stop size={14} />
        </button>
      )}
    </>
  )
}

const ProjectRow = ({
  project,
  active,
  onSelect
}: {
  project: ProjectWithState
  active: boolean
  onSelect: () => void
}) => {
  const sample = useEngine((s) => s.resources[project.id])
  const { busy, intent, running, warmingUp } = useLifecycleState(project)
  const port = primaryPort(project)

  return (
    <div className={`svc-row ${active ? "active" : ""} ${busy ? "busy" : ""}`} onClick={onSelect} role="button" tabIndex={0}>
      <ProjectAvatar project={project} className="svc-icon" />
      <span className="svc-body">
        <span className="svc-name">{project.name}</span>
        <span className="svc-meta">
          <StatusDot state={project.state} size={6} />
          {port !== undefined && <span className="svc-port">:{port}</span>}
          {running && sample !== undefined && (
            <span className="svc-stat">
              <span className="dot-sep">·</span>
              {sample.cpuPercent.toFixed(1)}%<span className="dot-sep">·</span>
              {formatMB(sample.rssBytes)}M
            </span>
          )}
          {busy ? (
            <span className="svc-health waiting">{intentLabel(intent!).toLowerCase()}</span>
          ) : warmingUp ? (
            <span className="svc-health waiting">starting up</span>
          ) : (
            project.health !== undefined &&
            project.health !== "unknown" && (
              <span className={`svc-health ${project.health}`}>{project.health}</span>
            )
          )}
        </span>
      </span>
      <span className="svc-primary-action" onClick={(e) => e.stopPropagation()}>
        <LifecycleButton project={project} />
      </span>
      <span className="svc-actions" onClick={(e) => e.stopPropagation()}>
        {port !== undefined && (
          <button
            className="ico"
            title="Open in browser"
            onClick={() => window.open(`http://localhost:${port}`, "_blank", "noopener")}
          >
            <Icons.Compass size={13} />
          </button>
        )}
        <button
          className="ico"
          title="Copy path"
          onClick={() => void navigator.clipboard?.writeText(project.root)}
        >
          <Icons.Copy size={12} />
        </button>
      </span>
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

  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [bucketCollapsed, setBucketCollapsed] = useState<Record<string, boolean>>({})

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
                          <ProjectRow
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
    </aside>
  )
}
