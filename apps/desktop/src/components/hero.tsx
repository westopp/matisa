import { useEffect, useState } from "react"
import type { ProjectWithState } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { Icons } from "./icons"
import { useLifecycleState } from "~/hooks/use-lifecycle-state"
import {
  formatMB,
  formatUptime,
  KindIcon,
  LifecycleButton,
  primaryPort,
  ProjectAvatar,
  StatusDot
} from "./primitives"

// ────────────────────────────────────────────────────────────────────────────
// The project hero. Every number here is engine-reported; the UI derives
// nothing about liveness (state-is-truth). `health` is shown next to `state`
// rather than folded into it — `running + timeout` is a real, distinct
// condition (process alive, declared port never bound).
//
// The runtime numbers ride as pills on the URL row rather than as a grid of
// cards: they are glanced at, not read, and the terminals below are what the
// vertical space belongs to.
// ────────────────────────────────────────────────────────────────────────────

const Sparkline = ({ data, width = 84, height = 26 }: { data: ReadonlyArray<number>; width?: number; height?: number }) => {
  if (data.length < 2) return null
  const max = Math.max(...data, 1)
  const step = width / (data.length - 1)
  const pts = data.map((v, i) => [i * step, height - (v / max) * (height - 4) - 2] as const)
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ")
  const last = pts[pts.length - 1]
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <path d={`${path} L${width},${height} L0,${height} Z`} fill="var(--accent-soft)" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {last !== undefined && <circle cx={last[0]} cy={last[1]} r={2} fill="var(--accent)" />}
    </svg>
  )
}

const StatPill = ({
  label,
  value,
  title,
  wide = false,
  children
}: {
  label: string
  value?: string | number
  title?: string
  wide?: boolean
  children?: React.ReactNode
}) => (
  <span className={`stat-pill ${wide ? "wide" : ""}`} title={title}>
    <span className="stat-key">{label}</span>
    {value !== undefined && <span className="stat-val">{value}</span>}
    {children}
  </span>
)

/** Runtime numbers, as pills. Health and the command line live elsewhere —
 *  health is already spelled out beside the status label, and the command is
 *  the first row of the commands table. */
const StatPills = ({ project }: { project: ProjectWithState }) => {
  const sample = useEngine((s) => s.resources[project.id])
  const [series, setSeries] = useState<ReadonlyArray<number>>([])

  // The engine samples resources; the sparkline is just the last 26 samples the
  // client has seen. Reset when switching projects so the trace never lies.
  useEffect(() => setSeries([]), [project.id])
  useEffect(() => {
    if (sample === undefined) return
    setSeries((prev) => [...prev, sample.cpuPercent].slice(-26))
  }, [sample])

  const port = primaryPort(project)

  return (
    <span className="stat-pills">
      <StatPill label="port" value={port ?? "—"} title="Declared port" />
      <StatPill label="pid" value={project.pid ?? "—"} title="Leader process" />
      <StatPill label="cpu" value={`${(sample?.cpuPercent ?? 0).toFixed(1)}%`} title="Process group CPU">
        <Sparkline data={series} width={34} height={12} />
      </StatPill>
      <StatPill label="mem" value={`${formatMB(sample?.rssBytes ?? 0)}MB`} title="Resident memory" />
      <StatPill label="path" value={project.root} title={project.root} wide />
    </span>
  )
}

export const ProjectHero = ({ project, onEdit }: { project: ProjectWithState; onEdit: () => void }) => {
  const restart = useEngine((s) => s.restart)
  const session = useEngine((s) => s.runSessions[project.id])
  const [copied, setCopied] = useState(false)

  const { busy, running, warmingUp } = useLifecycleState(project)
  const port = primaryPort(project)
  const url = port === undefined ? null : `http://localhost:${port}`

  const copy = (): void => {
    if (url === null) return
    void navigator.clipboard?.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="hero">
      <div className="hero-top">
        <div className="hero-id">
          <ProjectAvatar project={project} size={20} className="hero-icon" />
          <div className="hero-id-text">
            <div className="hero-status-row">
              <StatusDot state={project.state} size={8} />
              {/* `running` while the port is still unbound is up-but-not-usable.
                  Said plainly rather than shown as a settled green. */}
              <span className={`hero-status-label ${warmingUp ? "warming" : project.state}`}>
                {warmingUp ? "starting up" : project.state}
              </span>
              {project.health !== undefined && project.health !== "unknown" && !warmingUp && (
                <span className="hero-uptime">· {project.health}</span>
              )}
              {running && !warmingUp && (
                <span className="hero-uptime">· uptime {formatUptime(session?.since)}</span>
              )}
            </div>
            <h1 className="hero-name">
              {project.name}
              <span className="hero-kind">
                <KindIcon kind={project.kind} size={11} />
                {project.kind}
              </span>
            </h1>
          </div>
        </div>

        <div className="hero-top-actions">
          <button className="ico-btn" title="Edit project" onClick={onEdit} disabled={busy}>
            <Icons.Edit size={15} />
          </button>
          <button className="ico-btn" title="Reveal in Finder" onClick={() => void navigator.clipboard?.writeText(project.root)}>
            <Icons.Folder size={15} />
          </button>
        </div>
      </div>

      <div className="hero-url-row">
        <button className={`url-chip ${url === null ? "muted" : ""}`} onClick={copy} disabled={url === null}>
          <Icons.Globe size={13} />
          <span className="url-text">{url ?? "no port declared"}</span>
          {url !== null && (
            <span className="url-copy">
              <Icons.Copy size={12} />
            </span>
          )}
          {copied && <span className="url-copied-badge">Copied</span>}
        </button>

        <StatPills project={project} />

        {/* The same 26px control the sidebar draws, so a project's primary
            action is the same shape and size wherever you meet it. */}
        <div className="hero-actions">
          <LifecycleButton project={project} />
          <button
            className="ico-primary"
            title="Restart"
            onClick={() => void restart(project.id)}
            disabled={busy}
          >
            <Icons.Restart size={14} />
          </button>
          <span className="actions-divider" />
          <button
            className="ico-btn"
            title="Open in browser"
            disabled={url === null}
            onClick={() => url !== null && window.open(url, "_blank", "noopener")}
          >
            <Icons.Compass size={15} />
          </button>
          <button className="ico-btn" title="Copy URL" onClick={copy} disabled={url === null}>
            <Icons.Copy size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
