import { useEffect, useState } from "react"
import type { ExposureEntry, ProjectWithState } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { revealPath } from "~/store/store.picker"
import { openExternal } from "~/lib/native"
import { Icons } from "./icons"
import { useLifecycleState } from "~/hooks/use-lifecycle-state"
import { CollapsibleCard } from "./panels"
import { GitBar } from "./git.bar"
import {
  formatMB,
  formatUptime,
  isOurs,
  KillButton,
  KindIcon,
  LifecycleButton,
  primaryPort,
  ProjectAvatar,
  StatusFigure,
  useClaim
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

/** One hover-revealed action on a pill. Same contract as the environment pill's
 *  tools: absent from the resting row, so the numbers stay the thing you read. */
const StatTool = ({
  icon,
  title,
  onClick
}: {
  icon: React.ReactNode
  title: string
  onClick: () => void
}) => (
  <button className="stat-ico" title={title} aria-label={title} onClick={onClick}>
    {icon}
  </button>
)

const StatPill = ({
  label,
  value,
  title,
  wide = false,
  tools,
  children
}: {
  label: string
  value?: string | number
  title?: string
  wide?: boolean
  tools?: React.ReactNode
  children?: React.ReactNode
}) => (
  <span className={`stat-pill ${wide ? "wide" : ""}`} title={title}>
    <span className="stat-key">{label}</span>
    {value !== undefined && <span className="stat-val">{value}</span>}
    {children}
    {tools !== undefined && <span className="stat-tools">{tools}</span>}
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
      {/* A portless project is a worker, not a broken server — an em-dash where
          a port would be reads as "missing", so the pill is absent instead. */}
      {port !== undefined && <StatPill label="port" value={port} title="Declared port" />}
      <StatPill
        label="pid"
        value={project.pid ?? "—"}
        title="Leader process"
        // Nothing to copy until there is a process — the tools stay off rather
        // than offering a button that would put "—" on the clipboard.
        tools={
          project.pid === undefined ? undefined : (
            <StatTool
              icon={<Icons.Copy size={11} />}
              title="Copy PID"
              onClick={() => void navigator.clipboard?.writeText(String(project.pid))}
            />
          )
        }
      />
      <StatPill label="cpu" value={`${(sample?.cpuPercent ?? 0).toFixed(1)}%`} title="Process group CPU">
        <Sparkline data={series} width={34} height={12} />
      </StatPill>
      <StatPill label="mem" value={`${formatMB(sample?.rssBytes ?? 0)}MB`} title="Resident memory" />
      <StatPill
        label="path"
        value={project.root}
        title={project.root}
        wide
        tools={
          <>
            <StatTool
              icon={<Icons.Copy size={11} />}
              title="Copy path"
              onClick={() => void navigator.clipboard?.writeText(project.root)}
            />
            <StatTool
              icon={<Icons.FolderOpen size={11} />}
              title="Reveal in Finder"
              onClick={() => void revealPath(project.root)}
            />
          </>
        }
      />
    </span>
  )
}

/** One reachable address. Direct localhost is client-derived; every other chip
 *  mirrors an engine-reported ExposureEntry (thin-clients — the engine owns the
 *  URL derivation). Click = copy. Non-active entries render dimmed with the
 *  engine's message as the tooltip. */
const UrlChip = ({
  url,
  state,
  message,
  warn
}: {
  url: string
  state: ExposureEntry["state"]
  message?: string
  warn: boolean
}) => {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  const cls = state !== "active" ? "muted" : warn ? "warn" : ""
  return (
    <button className={`url-chip ${cls}`} onClick={copy} title={message ?? url}>
      <Icons.Globe size={13} />
      <span className="url-text">{url}</span>
      <span className="url-copy">
        <Icons.Copy size={12} />
      </span>
      {copied && <span className="url-copied-badge">Copied</span>}
    </button>
  )
}

/** The old app's unmanaged banner, and its blocked twin.
 *
 *  The row badge is a glance; this is the paragraph. It sits above the hero
 *  rather than inside it because it explains why the hero reads the way it does
 *  — a project that says `idle` while its port is busy, or one that says
 *  `unmanaged` with no logs behind it — and an explanation below the thing it
 *  explains is read second. */
const ForeignBanner = ({ project }: { project: ProjectWithState }) => {
  const claim = useClaim(project.id, project.state)
  const takeover = useEngine((s) => s.takeover)
  if (claim === undefined) return null

  const ours = isOurs(claim)
  return (
    <div className="foreign-banner">
      <Icons.Alert size={15} sw={2.2} />
      <div className="foreign-banner-text">
        <span className="foreign-banner-head">
          {ours ? "Running outside Matisa" : `Port ${claim.port ?? "?"} is in use`}
        </span>
        <span className="foreign-banner-body">
          {ours
            ? "Logs aren't captured and the controls are inert. Reclaim it to manage it here."
            : claim.message}
        </span>
      </div>
      {ours && (
        <button className="btn sm" onClick={() => void takeover(project.id)}>
          Reclaim
        </button>
      )}
    </div>
  )
}

export const ProjectHero = ({ project, onEdit }: { project: ProjectWithState; onEdit: () => void }) => {
  const restart = useEngine((s) => s.restart)
  const kill = useEngine((s) => s.kill)
  const session = useEngine((s) => s.runSessions[project.id])
  const entries = useEngine((s) => s.exposures[project.id])
  const caddy = useEngine((s) => s.caddy)
  const setLanShare = useEngine((s) => s.setLanShare)
  const updateProject = useEngine((s) => s.updateProject)
  // The project's own answer, not a row in the snapshot: an opted-out project
  // reports no stable_url entry at all, so the switch has to read the flag.
  const stableUrl = project.stableUrl !== false
  const [copied, setCopied] = useState(false)

  const { busy, running, warmingUp } = useLifecycleState(project)
  const port = primaryPort(project)
  const url = port === undefined ? null : `http://localhost:${port}`

  // `running + timeout` = the app never bound its declared port, so every
  // proxied URL below is routing to nothing. Say why, on the chips themselves.
  const portNeverBound = running && project.health === "timeout"
  const lanShared = entries?.some((e) => e.kind === "lan" && e.enabled) ?? false
  const canShare = port !== undefined && (caddy?.available ?? false)

  const copy = (): void => {
    if (url === null) return
    void navigator.clipboard?.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <>
    <ForeignBanner project={project} />
    <div className="hero">
      <div className="hero-top">
        <div className="hero-id">
          {/* Takes the project's tone at size — the same rule the selected
              card follows, so the pane and the rail agree at a glance. */}
          <ProjectAvatar project={project} size={22} className="hero-icon" />
          <div className="hero-id-text">
            <div className="hero-status-row">
              <StatusFigure state={project.state} projectId={project.id} size={16} dotSize={8} />
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
              {/* Beside the name because that is what it qualifies: which
                  version of this project you are looking at. */}
              <GitBar projectId={project.id} />
            </h1>
          </div>
        </div>

      </div>
    </div>

    {/* One container for every reading, and it collapses like Environment and
        Commands do. Open by default: unlike those two, this is consulted on
        every visit rather than opened to change something.
        The controls ride in the card's header, where Environment keeps Show all
        and Commands keeps + Command — the same slot, on the same line, so the
        pane has one row of actions rather than a second set floating above the
        title. The header does not collapse, so Start is always reachable. */}
    <CollapsibleCard
      id={`runtime-${project.id}`}
      icon={<Icons.Activity size={14} />}
      title="Runtime"
      defaultOpen
      actions={
        <div className="hero-actions">
          {/* Kill sits beside start/stop here exactly as it does on the card —
              same order, same neighbours — so the control you reach for when a
              stop will not finish is never somewhere new. */}
          <KillButton enabled={running || busy} onKill={() => void kill(project.id)} size={16} />
          <LifecycleButton project={project} />
          <button
            className="ico-primary"
            title="Restart"
            onClick={() => void restart(project.id)}
            disabled={busy}
          >
            <Icons.Restart size={18} />
          </button>
          <span className="actions-divider" />
          <button
            className={`ico-btn ${lanShared ? "active" : ""}`}
            title={
              !canShare
                ? port === undefined
                  ? "Declare a port to share on your network"
                  : "caddy not installed — brew install caddy"
                : lanShared
                  ? "Stop sharing on local network"
                  : "Share on local network"
            }
            disabled={!canShare}
            onClick={() => void setLanShare(project.id, !lanShared)}
          >
            <Icons.Broadcast size={15} />
          </button>
          {/* Beside LAN sharing, because they are the two exposures and reading
              them together is how you tell what this project publishes. The
              glyph is the eye rather than a globe: what it governs is whether
              the project is VISIBLE at a hostname, not whether it is running. */}
          <button
            className={`ico-btn ${stableUrl ? "active" : ""}`}
            title={
              port === undefined
                ? "Declare a port to get a stable URL"
                : stableUrl
                  ? `Stable URL on — http://<name>.localhost. Click to stop publishing through Caddy; localhost:${port} is unaffected`
                  : `Stable URL off — only http://localhost:${port} reaches this project`
            }
            disabled={port === undefined || busy}
            onClick={() => void updateProject(project.id, { stableUrl: !stableUrl })}
          >
            {stableUrl ? <Icons.Eye size={15} /> : <Icons.EyeOff size={15} />}
          </button>
          <button
            className="ico-btn"
            title="Open in browser"
            disabled={url === null}
            onClick={() => url !== null && openExternal(url)}
          >
            <Icons.Compass size={15} />
          </button>
          <button className="ico-btn" title="Copy URL" onClick={copy} disabled={url === null}>
            <Icons.Copy size={14} />
          </button>
          <span className="actions-divider" />
          <button className="ico-btn" title="Edit project" onClick={onEdit} disabled={busy}>
            <Icons.Edit size={15} />
          </button>
          <button
            className="ico-btn"
            title="Reveal in Finder"
            onClick={() => void revealPath(project.root)}
          >
            <Icons.Folder size={15} />
          </button>
        </div>
      }
    >
      <div className="hero-facts">
        {/* Every address this project answers on, the direct port first and its
            exposures after — one row, because "where do I reach this" is one
            question. A project with no port is told so rather than shown an
            empty space, since the absence is the reason there is nothing to
            click. */}
        {url === null ? (
          <button className="url-chip muted" disabled>
            <Icons.Globe size={13} />
            <span className="url-text">no port declared</span>
          </button>
        ) : (
          <span className="url-chips">
            <UrlChip
              url={url}
              state="active"
              warn={portNeverBound}
              {...(portNeverBound
                ? { message: `port ${port} never bound — app may be choosing its own port` }
                : {})}
            />
            {(entries ?? []).map((e) => (
              <UrlChip
                key={e.url}
                url={e.url}
                state={e.state}
                warn={portNeverBound}
                {...(portNeverBound && e.message === undefined
                  ? { message: `port ${port} never bound — app may be choosing its own port` }
                  : e.message !== undefined
                    ? { message: e.message }
                    : {})}
              />
            ))}
          </span>
        )}

        <StatPills project={project} />
      </div>
    </CollapsibleCard>
    </>
  )
}
