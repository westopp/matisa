import { useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useEngine } from "~/store/store.engine"
import { SYSTEM_IDS } from "~/store/store.systems"
import { rpc } from "~/rpc/rpc.client"
import { inShell, startEngine } from "~/lib/native"
import { Icons } from "./icons"
import { Spinner } from "./primitives"

// ────────────────────────────────────────────────────────────────────────────
// The banner — one full-width strip under the titlebar for conditions that
// affect the WHOLE window, not one project.
//
// It exists because of how the engine going down used to read: every card went
// quiet, a toast came and went, and the only place that actually said the
// connection was gone was the Engine system page — which you had to know to go
// and look at. A condition that makes the entire app inert has to announce
// itself where you already are.
//
// Three rules keep it from becoming chrome people learn to ignore:
//
//   * Every notice is DERIVED from live state, never dismissed and never
//     stored. It is on screen exactly as long as the thing it describes is
//     true, so it cannot go stale and there is no "dismissed but still broken"
//     state to get wrong.
//   * Every notice carries the action that fixes it. A banner that only names
//     a problem has moved the user's next step somewhere else, which is the
//     complaint this answers.
//   * Only whole-window conditions qualify. A project that failed to start is
//     that project's business — it has a card, a toast and the inspector. Put
//     it here and the strip is permanent furniture.
// ────────────────────────────────────────────────────────────────────────────

interface Action {
  readonly label: string
  readonly onClick: () => void
  readonly primary?: boolean
  /** The action is already in flight: spinner in place of nothing, and the
   *  button refuses further clicks. Derived from live state like everything
   *  else here — never a flag set on click, which would have to be unset by
   *  someone and would lie whenever nobody did. */
  readonly busy?: boolean
}

interface Notice {
  readonly id: string
  readonly tone: "danger" | "warning"
  readonly title: string
  readonly detail?: string
  readonly actions: ReadonlyArray<Action>
}

/** The engine is "connecting" for a moment on every cold start, and a banner
 *  that flashes on load is one people learn to blink past. So a connection that
 *  has never been open is given a grace period; one that WAS open and dropped is
 *  reported immediately, because that is a real event the user should see. */
const GRACE_MS = 2000

const useEngineDown = (): boolean => {
  const status = useEngine((s) => s.status)
  const everOpen = useRef(false)
  const [graceOver, setGraceOver] = useState(false)

  if (status === "open") everOpen.current = true

  useEffect(() => {
    const t = setTimeout(() => setGraceOver(true), GRACE_MS)
    return () => clearTimeout(t)
  }, [])

  if (status === "open") return false
  return everOpen.current || graceOver
}

const useNotices = (): ReadonlyArray<Notice> => {
  const navigate = useNavigate()
  const status = useEngine((s) => s.status)
  const daemon = useEngine((s) => s.daemon)
  const projects = useEngine((s) => s.projects)
  const startDaemon = useEngine((s) => s.startDaemon)
  const engineDown = useEngineDown()

  const notices: Array<Notice> = []

  if (engineDown) {
    const connecting = status === "connecting"
    const openSystem = (systemId: string): void =>
      void navigate({ to: "/system/$systemId", params: { systemId }, viewTransition: true })

    notices.push({
      id: "engine",
      tone: "danger",
      title: status === "connecting" ? "Reconnecting to the engine…" : "The engine is not running",
      // Nothing in this window works without the engine — it owns every project,
      // every terminal and all the state — so the detail says what is actually
      // unavailable rather than restating the title. Kept short because it is
      // the part that truncates first; the socket URL is one click away on the
      // Engine page rather than spending the width here.
      detail: "Nothing can start, stop or report until it is back.",
      // In the app the shell owns the engine and can simply start it, so the
      // banner offers that rather than telling anyone to go and run something.
      // In a browser tab there is no daemon to spawn from here, so the only
      // honest offer is to look again — the engine is started outside the
      // window in that case, and a "Start engine" button that could not would
      // be worse than none.
      // `connecting` is the socket actually mid-handshake — `reconnectNow` sets
      // it synchronously and the close handler clears it — so the button says
      // "trying" for exactly as long as a try is running, and comes back the
      // moment the attempt fails. Both offers lead to the same handshake, so
      // both wear it; a spinner on one while the other invited a second attempt
      // at the same socket would be worse than none.
      actions: inShell()
        ? [
            {
              label: "Start engine",
              onClick: () => void startEngine()?.then(() => rpc.reconnectNow()),
              primary: true,
              busy: connecting
            },
            { label: "Engine details", onClick: () => openSystem(SYSTEM_IDS.engine.slice(4)) }
          ]
        : [
            { label: "Try again", onClick: () => rpc.reconnectNow(), primary: true, busy: connecting },
            { label: "Engine details", onClick: () => openSystem(SYSTEM_IDS.engine.slice(4)) }
          ]
    })
  }

  // Only when something actually needs it. A Docker daemon that is down is
  // irrelevant to a catalog of plain processes, and a banner that is irrelevant
  // is the one that teaches people to stop reading banners.
  const needsDocker = projects.some((p) => p.kind === "docker" || p.kind === "compose")
  if (needsDocker && (daemon.state === "stopped" || daemon.state === "start_failed")) {
    notices.push({
      id: "docker",
      tone: "warning",
      title:
        daemon.state === "start_failed" ? "Docker did not start" : "Docker is not running",
      detail:
        daemon.message ??
        `${projects.filter((p) => p.kind === "docker" || p.kind === "compose").length} project(s) here run in containers and cannot start without it.`,
      actions: [{ label: "Start Docker", onClick: () => void startDaemon(), primary: true }]
    })
  }

  return notices
}

export const Banner = () => {
  const notices = useNotices()
  if (notices.length === 0) return null

  return (
    <div className="banners">
      {notices.map((n) => (
        <div key={n.id} className={`banner ${n.tone}`} role="status">
          <span className="banner-ico">
            <Icons.Alert size={14} />
          </span>
          <span className="banner-text">
            <strong className="banner-title">{n.title}</strong>
            {n.detail !== undefined && <span className="banner-detail">{n.detail}</span>}
          </span>
          <span className="banner-actions">
            {n.actions.map((a) => (
              <button
                key={a.label}
                className={`btn sm ${a.primary === true ? "primary" : ""}`}
                onClick={a.onClick}
                disabled={a.busy === true}
                aria-busy={a.busy === true}
              >
                {/* Beside the label, not instead of it. The button keeps its
                    width and its name through the attempt, so the strip does
                    not reflow under the pointer and the control the user just
                    pressed is still the one they can see. */}
                {a.busy === true && <Spinner size={12} />}
                {a.label}
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}
