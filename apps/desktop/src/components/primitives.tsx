import type { ProjectKind, ProjectWithState, RuntimeState } from "@matisa/core"
import { intentLabel, useLifecycleState } from "~/hooks/use-lifecycle-state"
import { useEngine } from "~/store/store.engine"
import { useIcon } from "~/store/store.icons"
import { Icons } from "./icons"

// Small shared pieces — the vocabulary the sidebar, hero and terminals all speak.

/** Indeterminate spinner. Indeterminate because we genuinely cannot know how
 *  long a start or a drain will take — a progress bar would be a fiction. */
export const Spinner = ({ size = 12 }: { size?: number }) => (
  <span className="spinner" style={{ width: size, height: size }} aria-hidden />
)

export const StatusDot = ({ state, size = 8 }: { state: RuntimeState; size?: number }) => {
  const color =
    state === "running"
      ? "var(--success)"
      : state === "crashed" || state === "errored"
        ? "var(--danger)"
        : state === "starting" || state === "stopping"
          ? "var(--warning)"
          : state === "unmanaged"
            ? "var(--text-dim)"
            : "var(--text-faint)"
  const transient = state === "starting" || state === "stopping"
  return (
    <span
      className={transient ? "status-dot-pulse" : undefined}
      style={{ width: size, height: size, borderRadius: 999, background: color, display: "inline-block", flexShrink: 0 }}
    />
  )
}

export const kindClass = (kind: ProjectKind): string =>
  kind === "docker" ? "stack" : kind === "compose" ? "compose" : ""

export const KindIcon = ({ kind, size = 14 }: { kind: ProjectKind; size?: number }) =>
  kind === "docker" ? <Icons.Docker size={size} /> : kind === "compose" ? <Icons.Stack size={size} /> : <Icons.Code size={size} />

/** The project's own artwork when it has any, the generic kind glyph when not.
 *  The tile keeps its shape either way, so a list of mixed projects still lines
 *  up. */
export const ProjectAvatar = ({
  project,
  size = 14,
  className = ""
}: {
  project: ProjectWithState
  size?: number
  className?: string
}) => {
  const uri = useIcon(project.pathToIcon)
  return (
    <span className={`avatar ${kindClass(project.kind)} ${uri === null ? "" : "has-art"} ${className}`}>
      {uri === null ? <KindIcon kind={project.kind} size={size} /> : <img src={uri} alt="" draggable={false} />}
    </span>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// The one start/stop control. Start shows only when stopped, Stop only when
// running, and both render into the same 26px slot so the control never moves
// under the pointer. A transition replaces both with a spinner — a project that
// is coming up or going down takes no further orders until it settles.
// ────────────────────────────────────────────────────────────────────────────

export const LifecycleButton = ({ project, size = 14 }: { project: ProjectWithState; size?: number }) => {
  const start = useEngine((s) => s.start)
  const stop = useEngine((s) => s.stop)
  const { busy, intent, running } = useLifecycleState(project)

  if (busy) {
    return (
      <button className="ico-primary busy" title={intentLabel(intent!)} disabled>
        <Spinner size={size - 2} />
      </button>
    )
  }

  return running ? (
    <button className="ico-primary danger" title="Stop" onClick={() => void stop(project.id)}>
      <Icons.Stop size={size} />
    </button>
  ) : (
    <button className="ico-primary success" title="Start" onClick={() => void start(project.id)}>
      <Icons.Play size={size} />
    </button>
  )
}

/** How long a collapse takes, everywhere. The library defaults to 500ms, which
 *  reads as lag on a tree you open and close constantly. */
export const COLLAPSE_DURATION = "160ms"

/** The project's first declared port — the one the health probe watches. */
export const primaryPort = (p: ProjectWithState): number | undefined => p.ports[0]?.number

export const commandLine = (p: ProjectWithState): string => {
  if (p.kind === "docker") return p.image ?? "—"
  if (p.kind === "compose") return p.composeFile ?? "—"
  if (p.command === undefined) return "—"
  return [p.command.program, ...p.command.args].join(" ")
}

export const formatUptime = (since: number | undefined): string => {
  if (since === undefined) return "—"
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000))
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${secs % 60}s`
}

export const formatMB = (bytes: number): number => Math.round(bytes / (1024 * 1024))
