import { useLayoutEffect, useRef, useState } from "react"
import type { CrashRecord, ProjectId, ProjectKind, ProjectWithState, RuntimeState } from "@matisa/core"
import type { CommandStatus } from "~/hooks/use-command-run"
import { intentLabel, useLifecycleState } from "~/hooks/use-lifecycle-state"
import { useEngine } from "~/store/store.engine"
import { useIcon } from "~/store/store.icons"
import { useUi } from "~/store/store.ui"
import { Icons } from "./icons"

// Small shared pieces — the vocabulary the sidebar, hero and terminals all speak.

/** Indeterminate spinner. Indeterminate because we genuinely cannot know how
 *  long a start or a drain will take — a progress bar would be a fiction. Sized
 *  4px under the Play/Stop glyph it stands in for: a closed ring reads heavier
 *  than an open triangle at equal box, so matching the number over-weights it. */
export const Spinner = ({ size = 14 }: { size?: number }) => (
  <span className="spinner" style={{ width: size, height: size }} aria-hidden />
)

/** The one place a runtime state becomes a colour — shared by the dot and the
 *  running-man glyph so both read the same at a glance.
 *
 *  Red is reserved for failure. A stopped project has not gone wrong — it is
 *  simply not up — so `idle` takes the trim colour, which leaves coral meaning
 *  exactly one thing wherever it appears. */
export const stateColor = (state: RuntimeState): string =>
  state === "running"
    ? "var(--success)"
    : state === "crashed" || state === "errored"
      ? "var(--danger)"
      : state === "idle"
        ? "var(--accent)"
        : state === "starting" || state === "stopping"
          ? "var(--warning)"
          : state === "unmanaged"
            ? "var(--text-dim)"
            : "var(--text-faint)"

export const StatusDot = ({ state, size = 8 }: { state: RuntimeState; size?: number }) => {
  const transient = state === "starting" || state === "stopping"
  return (
    // Classed as well as styled: the colour is inline (one function owns the
    // state→colour rule for every surface), so a card that fills itself with a
    // tone needs something to hang an override on.
    <span
      className={`status-dot ${transient ? "status-dot-pulse" : ""}`}
      style={{ width: size, height: size, borderRadius: 999, background: stateColor(state), display: "inline-block", flexShrink: 0 }}
    />
  )
}

// ────────────────────────────────────────────────────────────────────────────
// The running-man status glyph — shown beside the port while a project runs.
// A nested pivot rig animated with CSS TRANSFORMS ONLY: each leg is a thigh
// group rotating about the hip with a shin group nested inside rotating about
// the knee (same for upper arm / forearm about shoulder / elbow), so knees
// and elbows genuinely bend through the six-pose cycle
// strike → stance → toe-off → fold → drive → reach.
//
// Transforms-only is a hard requirement, learned the expensive way:
//   • SMIL <animate> of `d` — Blink parses the values as the CSS `d`
//     property, so raw path data is silently ignored.
//   • CSS `d: path(…)` keyframes — not supported in WebKit; the figure
//     froze while the (transform-based) bob kept moving.
// Rotations animate in every engine this app can meet.
//
// Geometry is authored with every limb hanging straight down; styles.css owns
// the posing (base transforms = the strike pose, keyframes override them with
// the gait). The far side plays the SAME keyframes half a stride behind via a
// negative animation-delay and is dimmed for depth — anti-phase arms and legs
// fall out of that offset by construction.
// ────────────────────────────────────────────────────────────────────────────

/** One articulated limb: the outer group swings from the joint (hip/shoulder),
 *  the inner group bends from the mid-joint (knee/elbow). `rig` picks which
 *  gait's classes it wears — run and walk are separate rigs on purpose (their
 *  geometry, pivots and cadence all differ), sharing only this shape. */
const Limb = ({
  rig,
  cls,
  upper,
  lower
}: {
  rig: "runner" | "walker"
  cls: "leg" | "arm"
  upper: string
  lower: string
}) => (
  <g className={cls === "leg" ? `${rig}-thigh` : `${rig}-uarm`}>
    <path d={upper} />
    <g className={cls === "leg" ? `${rig}-shin` : `${rig}-fore`}>
      <path d={lower} />
    </g>
  </g>
)

/** Shared canvas for every figure: same viewBox, stroke weight and colour rule,
 *  so a row swapping one figure for another never shifts or changes weight. */
const Figure = ({
  cls,
  state,
  size,
  children
}: {
  cls: string
  state: RuntimeState
  size: number
  children: React.ReactNode
}) => (
  <svg
    className={`figure ${cls}`}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ color: stateColor(state) }}
    aria-hidden
  >
    {children}
  </svg>
)

export const RunningMan = ({ state, size = 14 }: { state: RuntimeState; size?: number }) => (
  <Figure cls="runner" state={state} size={size}>
    <g className="runner-bob">
      {/* Far side first and dimmed, so the near limbs draw over it. */}
      <g className="runner-far" opacity="0.5">
        <Limb rig="runner" cls="arm" upper="M13.3 7.6L13.3 11" lower="M13.3 11L13.3 14.2" />
        <Limb rig="runner" cls="leg" upper="M11 13.4L11 17.7" lower="M11 17.7L11 22.1" />
      </g>
      <circle cx="14.6" cy="4.8" r="1.9" fill="currentColor" stroke="none" />
      <path d="M13.3 7.6L11 13.4" />
      <Limb rig="runner" cls="leg" upper="M11 13.4L11 17.7" lower="M11 17.7L11 22.1" />
      <Limb rig="runner" cls="arm" upper="M13.3 7.6L13.3 11" lower="M13.3 11L13.3 14.2" />
    </g>
  </Figure>
)

// ────────────────────────────────────────────────────────────────────────────
// The walking man — a project in transition. Same rig technique as the runner
// (nested pivots, transforms only) at a walk: near-upright posture, longer
// cadence, one foot always down, arms swinging rather than pumping. Colour
// comes from `stateColor`, so both transient states read amber.
//
// Direction carries the meaning: starting walks the way the runner faces
// (+x, forward), stopping mirrors the whole figure so it walks back out the
// way it came. Mirroring — rather than playing the gait backwards — is what
// keeps the stride natural; a reversed cycle reads as a moonwalk.
// ────────────────────────────────────────────────────────────────────────────

export const WalkingMan = ({
  state,
  size = 14,
  reverse
}: {
  state: RuntimeState
  size?: number
  /** Walk toward -x. Defaults to true for `stopping` — going away. */
  reverse?: boolean
}) => (
  <Figure cls={`walker ${(reverse ?? state === "stopping") ? "figure-rev" : ""}`} state={state} size={size}>
    {/* No vertical bob. A running figure rises and falls because it leaves the
        ground; a walker never does, and at 14px the bounce read as jitter in a
        list rather than as gait. */}
    <g>
      <g className="walker-far" opacity="0.5">
        <Limb rig="walker" cls="arm" upper="M12.4 7.6L12.4 11" lower="M12.4 11L12.4 14" />
        <Limb rig="walker" cls="leg" upper="M11.9 13.5L11.9 18" lower="M11.9 18L11.9 22.2" />
      </g>
      {/* Head sits over the shoulders, spine vertical: a walk is upright. The
          runner's forward lean is what a run looks like — on a walker it reads
          as trudging. Facing comes from the limbs, not from a slump.
          The shoulder sits half a unit in front of the spine so the arms clear
          the torso stroke — on the spine they vanish into it at 14px. */}
      <circle cx="12.4" cy="4.5" r="1.9" fill="currentColor" stroke="none" />
      <path d="M11.9 7.4L11.9 13.5" />
      <Limb rig="walker" cls="leg" upper="M11.9 13.5L11.9 18" lower="M11.9 18L11.9 22.2" />
      <Limb rig="walker" cls="arm" upper="M12.4 7.6L12.4 11" lower="M12.4 11L12.4 14" />
    </g>
  </Figure>
)

// ────────────────────────────────────────────────────────────────────────────
// The failure glyph — `crashed` and `errored` only.
//
// Stopped and broken used to be the same red dot, which made the two states
// indistinguishable at the one size the sidebar actually draws them. A triangle
// separates them by SHAPE, which survives at 6px where a hue shift does not.
//
// It carries the reason twice over. On hover, the newest failure's summary is
// shown inline — the point being that "why did this die" should not cost a
// click. Clicking opens the drawer's Failures tab for the full record: exit
// code, timestamps, and the log tail behind it.
// ────────────────────────────────────────────────────────────────────────────

/** The newest recorded failure for a project, or undefined when the client has
 *  no record of it (crashed before this session, or older than the window). */
export const useLatestFailure = (projectId: ProjectId | undefined): CrashRecord | undefined =>
  // `failures` is newest-first everywhere it is written, so the first match is
  // the most recent one — no sorting, and no new array to re-render on.
  useEngine((s) => (projectId === undefined ? undefined : s.failures.find((f) => f.projectId === projectId)))

const failureText = (state: RuntimeState, failure: CrashRecord | undefined): string => {
  const what = state === "crashed" ? "Crashed" : "Failed to start"
  if (failure?.summary !== undefined) return `${what} — ${failure.summary}`
  // No record: say so rather than inventing a cause. The state itself is still
  // the honest headline.
  return state === "crashed" ? "Crashed — no output was captured" : "The engine could not start this project"
}

/** Where the tip goes, in viewport coordinates. `position: fixed` because every
 *  surface that draws this glyph — the sidebar list, the hero — sits inside an
 *  `overflow: hidden` column: an absolutely-positioned tip would be sliced off
 *  at the first row, which is exactly the row a failure is most likely to be
 *  on. Nothing in the chain establishes a containing block (no transforms), so
 *  fixed anchors to the viewport and escapes the clipping entirely. */
interface TipAnchor {
  readonly x: number
  /** The glyph's own edges, kept so the tip can flip sides after measuring. */
  readonly top: number
  readonly bottom: number
  readonly above: boolean
  /** Set once the measured pass has run, so the correction never re-enters. */
  readonly settled: boolean
}

/** Enough room for the tallest the tip gets (three clamped lines + heading).
 *  Only the first guess; the measured pass below corrects it. */
const TIP_HEIGHT = 96

/** Breathing room from the window edge, and the visual gap to the glyph. The
 *  gap is bridged by a transparent strip on the tip itself (see styles.css) —
 *  the pointer must be able to cross into the tip without passing over a
 *  non-descendant, or the tip closes before it can be read. */
const TIP_MARGIN = 8
const TIP_GAP = 6

/** Everything the mark needs to report a failure and offer the way out of it.
 *  Supplied by the caller rather than looked up here, because the surfaces that
 *  draw this mark fail for different reasons: a project has a crash record and
 *  a drawer to show it in, a command has an exit code and a terminal. The tip,
 *  its placement and its two buttons are the same either way. */
export interface FailureDetail {
  /** The tip's title — what happened. */
  readonly headline: string
  /** The tip's body — why, as far as anything knows. */
  readonly body: string
  /** The glyph's own tooltip: headline and body in one line. */
  readonly reason: string
  /** Exit code or signal, shown as a chip beside the headline. */
  readonly exit?: number | string
  readonly resetTitle: string
  readonly onReset: () => void
  /** The second button, when there is somewhere to go for the full story. */
  readonly details?: { readonly label: string; readonly onClick: () => void }
}

/** The failure triangle and its reason tip. Hover reads the reason, and the two
 *  things you can do about it — look, and reset — sit in the tip, because the
 *  place a reason is read is the place those belong. */
export const FailureMark = ({ detail, size = 13 }: { detail: FailureDetail; size?: number }) => {
  const [anchor, setAnchor] = useState<TipAnchor | null>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const { headline, body, reason, exit } = detail

  // One corrective pass once the tip has real dimensions. The first placement
  // centres on the glyph, which runs off the window whenever the glyph sits
  // within half a tip of an edge — and in the sidebar it always does. Measuring
  // beats guessing at the width: the tip is `max-content` up to a cap, so how
  // wide it actually is depends on the failure text.
  useLayoutEffect(() => {
    const el = tipRef.current
    if (anchor === null || el === null || anchor.settled) return
    const r = el.getBoundingClientRect()
    const dx =
      r.left < TIP_MARGIN
        ? TIP_MARGIN - r.left
        : r.right > window.innerWidth - TIP_MARGIN
          ? window.innerWidth - TIP_MARGIN - r.right
          : 0
    // Flip up if the guess put it below and it does not actually fit there.
    const above = anchor.above || r.bottom > window.innerHeight - TIP_MARGIN
    setAnchor({ ...anchor, x: anchor.x + dx, above, settled: true })
  }, [anchor])

  const glyph = (
    <span className="failure-glyph" style={{ width: size, height: size }}>
      <Icons.Alert size={size} sw={2.2} />
    </span>
  )

  // Measured at the moment of hover, not on mount: rows scroll, and a position
  // captured earlier would put the tip somewhere the glyph no longer is.
  const place = (e: { currentTarget: HTMLElement }): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setAnchor({
      x: r.left + r.width / 2,
      top: r.top - TIP_GAP,
      bottom: r.bottom + TIP_GAP,
      above: r.top > TIP_HEIGHT,
      settled: false
    })
  }

  const reset = (): void => {
    setAnchor(null)
    detail.onReset()
  }

  // A span, not a button: the tip it owns now carries its own controls, and a
  // button cannot contain buttons. Hover lives on the wrapper so crossing from
  // the glyph into the tip is never a leave.
  return (
    <span
      className="failure-mark"
      onMouseEnter={place}
      onFocus={place}
      onMouseLeave={() => setAnchor(null)}
      onBlur={() => setAnchor(null)}
    >
      <button
        className="failure-glyph-btn"
        aria-label={detail.details === undefined ? reason : `${reason} — show details`}
        // The click also selects the row it sits in (the handler does not stop
        // propagation), so the drawer opens onto the project you just pointed at.
        onClick={() => detail.details?.onClick()}
      >
        {glyph}
      </button>
      {/* Beside the triangle, never instead of it: the failure stays readable
          while the way out of it sits next to it. */}
      <button
        className="failure-reset"
        title={detail.resetTitle}
        aria-label={detail.resetTitle}
        onClick={(e) => {
          e.stopPropagation()
          reset()
        }}
      >
        <Icons.Reset size={size - 1} sw={2.2} />
      </button>
      {anchor !== null && (
        <span
          ref={tipRef}
          className={`failure-tip ${anchor.above ? "above" : "below"} ${anchor.settled ? "settled" : ""}`}
          role="tooltip"
          style={{ left: anchor.x, top: anchor.above ? anchor.top : anchor.bottom }}
        >
          <span className="failure-tip-head">
            {headline}
            {exit !== undefined && <span className="failure-tip-exit">{exit}</span>}
          </span>
          <span className="failure-tip-body">{body}</span>
          {/* The tip is where the reason is read, so it is also where the two
              things you can do about it belong. */}
          <span className="failure-tip-acts" onClick={(e) => e.stopPropagation()}>
            {detail.details !== undefined && (
              <button className="failure-tip-btn" onClick={detail.details.onClick}>
                {detail.details.label}
              </button>
            )}
            <button className="failure-tip-btn primary" onClick={reset}>
              <Icons.Reset size={11} sw={2.2} /> Reset
            </button>
          </span>
        </span>
      )}
    </span>
  )
}

/** The project's failure, in the shared mark: the crash record for the reason,
 *  the drawer for the full story, and the engine's own reset for the way out. */
export const FailureGlyph = ({
  state,
  projectId,
  size = 13
}: {
  state: RuntimeState
  /** Omit for surfaces with no project behind them (the Systems rows): the
   *  glyph then states the problem without offering details it cannot show. */
  projectId?: ProjectId
  size?: number
}) => {
  const failure = useLatestFailure(projectId)
  const openDrawer = useUi((s) => s.openDrawer)
  const resetProject = useEngine((s) => s.resetProject)
  const reason = failureText(state, failure)
  const exit = failure?.signal ?? failure?.exitCode

  if (projectId === undefined) {
    return (
      <span className="failure-mark" title={reason} aria-label={reason}>
        <span className="failure-glyph" style={{ width: size, height: size }}>
          <Icons.Alert size={size} sw={2.2} />
        </span>
      </span>
    )
  }

  return (
    <FailureMark
      size={size}
      detail={{
        headline: state === "crashed" ? "Crashed" : "Failed to start",
        body:
          failure?.summary ??
          (state === "crashed" ? "No output was captured." : "The engine could not start this project."),
        reason,
        ...(exit === undefined ? {} : { exit }),
        resetTitle: "Reset — back to idle, and forget this failure",
        onReset: () => void resetProject(projectId),
        details: { label: "Details", onClick: () => openDrawer("failures") }
      }}
    />
  )
}

/** The one glyph every surface asks for: the moving figure while a project runs
 *  or transitions, the failure triangle when it broke, the dot the rest of the
 *  time. A figure at rest was tried and cut — at 14px an idle pose is a
 *  scribble, and a stopped project is better said with a dot than mimed. */
export const StatusFigure = ({
  state,
  projectId,
  size = 14,
  dotSize = 6,
  failure
}: {
  state: RuntimeState
  projectId?: ProjectId
  size?: number
  dotSize?: number
  /** What broke, for surfaces that are not a project — a named command's
   *  terminal, say. Without it the mark falls back to the project's own crash
   *  record. */
  failure?: FailureDetail
}) => {
  if (state === "running") return <RunningMan state={state} size={size} />
  if (state === "starting" || state === "stopping") return <WalkingMan state={state} size={size} />
  if (state === "crashed" || state === "errored")
    return failure === undefined ? (
      <FailureGlyph state={state} projectId={projectId} size={size - 1} />
    ) : (
      <FailureMark detail={failure} size={size - 1} />
    )
  return <StatusDot state={state} size={dotSize} />
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
// running, and both render into the same 32px slot so the control never moves
// under the pointer. A transition replaces both with a spinner — a project that
// is coming up or going down takes no further orders until it settles.
// ────────────────────────────────────────────────────────────────────────────

export const LifecycleButton = ({ project, size = 18 }: { project: ProjectWithState; size?: number }) => {
  const start = useEngine((s) => s.start)
  const stop = useEngine((s) => s.stop)
  const takeover = useEngine((s) => s.takeover)
  const { busy, intent, running, stalled } = useLifecycleState(project)

  if (busy) {
    return (
      <button className="ico-primary busy" title={intentLabel(intent!)} disabled>
        <Spinner size={size - 4} />
      </button>
    )
  }

  // `unmanaged` is the one state where the obvious control is the wrong one.
  // The project IS up — started in a terminal, or by a previous engine — so a
  // Start would only fail on its own port, and a Stop has nothing here to
  // signal. Reclaim is what the user actually wants: end the foreign holder,
  // then run it under matisa. The engine refuses on weak evidence and says so,
  // which is why this can be a single press rather than a dialog.
  if (project.state === "unmanaged") {
    return (
      <button
        className="ico-primary warn"
        title="Running outside matisa — reclaim it (stops the process holding the port, then starts it here)"
        onClick={() => void takeover(project.id)}
      >
        <Icons.Restart size={size} />
      </button>
    )
  }

  // A transition the engine never finished leaves the control live rather than
  // disabled forever — the tooltip says why it looks odd.
  const stuckNote = stalled ? ` (stuck in ${project.state} — this will retry)` : ""

  return running ? (
    <button className="ico-primary danger" title={`Stop${stuckNote}`} onClick={() => void stop(project.id)}>
      <Icons.Stop size={size} />
    </button>
  ) : (
    <button className="ico-primary success" title={`Start${stuckNote}`} onClick={() => void start(project.id)}>
      <Icons.Play size={size} />
    </button>
  )
}

/** The run control for one named command: play when it is not up, stop when it
 *  is, a spinner while the engine is opening the session. Same three states,
 *  same slot, as the project's own lifecycle button — the commands table and
 *  the terminal pane both draw it, and they must not disagree. */
export const CommandRunButton = ({
  status,
  onRun,
  onStop,
  size = 18
}: {
  status: CommandStatus
  onRun: () => void
  onStop: () => void
  size?: number
}) => {
  if (status === "starting") {
    return (
      <button className="ico-primary busy" title="Starting…" disabled>
        <Spinner size={size - 4} />
      </button>
    )
  }
  return status === "running" ? (
    <button className="ico-primary danger" title="Interrupt (Ctrl-C)" onClick={onStop}>
      <Icons.Stop size={size} />
    </button>
  ) : (
    <button className="ico-primary success" title="Run" onClick={onRun}>
      <Icons.Play size={size} />
    </button>
  )
}

/** Stop a command and run it again, drawn beside the start/stop control on every
 *  surface that draws one. Always present and disabled when idle, for the same
 *  reason KillButton is: a control that appears and disappears under the pointer
 *  is a control you cannot aim at. Restarting something that is not running is
 *  just Run, which is already the button to its right. */
export const CommandRestartButton = ({
  enabled,
  onRestart,
  size = 15
}: {
  enabled: boolean
  onRestart: () => void
  size?: number
}) => (
  <button
    className="ico"
    title={enabled ? "Restart — stop it and run it again" : "Nothing to restart"}
    disabled={!enabled}
    onClick={onRestart}
  >
    <Icons.Restart size={size} />
  </button>
)

/** Force-kill, drawn wherever a start/stop control is drawn. Always present so
 *  the row of controls keeps one shape; disabled when there is nothing alive to
 *  kill, rather than appearing and disappearing under the pointer. */
export const KillButton = ({
  enabled,
  onKill,
  title = "Force kill — no drain, no waiting",
  size = 15
}: {
  enabled: boolean
  onKill: () => void
  title?: string
  size?: number
}) => (
  <button
    className="ico danger-hover"
    title={enabled ? title : "Nothing to kill"}
    disabled={!enabled}
    onClick={onKill}
  >
    {/* Solid while there is something to kill, outline while there is not —
        the weight says "live" before the colour or the cursor does. */}
    <Icons.Skull size={size} filled={enabled} />
  </button>
)

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
