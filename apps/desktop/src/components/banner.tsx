import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { useEngine } from "~/store/store.engine"
import { SYSTEM_IDS } from "~/store/store.systems"
import { rpc } from "~/rpc/rpc.client"
import {
  appVersion,
  applyUpdate,
  cliLinkState,
  inShell,
  installCli,
  startEngine,
  subscribeUpdateState,
  type CliLinkState,
  type UpdateState
} from "~/lib/native"
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
  /** `info` is not a problem — it is the update strip. It stays because the
   *  same rule as everything else here applies: derived from live state, so it
   *  is on screen exactly as long as an update is waiting, and there is no
   *  dismissal to remember or to get wrong. */
  readonly tone: "danger" | "warning" | "info"
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

/** Whether `matisa` is on PATH, re-asked whenever the window comes back to the
 *  front. That is the one moment the answer can have changed without this
 *  window doing anything: the user went to a terminal and ran the command they
 *  copied. `null` until the first answer arrives, so the strip does not appear
 *  for a frame on every launch before the check has run. */
const useCliLink = (): readonly [CliLinkState | null, () => void] => {
  const [state, setState] = useState<CliLinkState | null>(null)
  const check = useCallback(() => void cliLinkState().then(setState), [])
  useEffect(() => {
    check()
    window.addEventListener("focus", check)
    return () => window.removeEventListener("focus", check)
  }, [check])
  return [state, check]
}

const useUpdateState = (): UpdateState => {
  const [state, setState] = useState<UpdateState>({ phase: "idle" })
  useEffect(() => subscribeUpdateState(setState), [])
  return state
}

const useNotices = (): ReadonlyArray<Notice> => {
  const navigate = useNavigate()
  const status = useEngine((s) => s.status)
  const daemon = useEngine((s) => s.daemon)
  const projects = useEngine((s) => s.projects)
  const engine = useEngine((s) => s.engine)
  const startDaemon = useEngine((s) => s.startDaemon)
  const shutdownEngine = useEngine((s) => s.shutdownEngine)
  const restartEngine = useEngine((s) => s.restartEngine)
  const engineDown = useEngineDown()
  const update = useUpdateState()
  const [applying, setApplying] = useState(false)
  const [linking, setLinking] = useState(false)
  const [cli, recheckCli] = useCliLink()
  const [restarting, setRestarting] = useState(false)

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

  // The daemon answering this window is not the one this build ships.
  //
  // This is what an app update leaves behind. The engine is shared and outlives
  // the app on purpose, so a swapped bundle finds the previous build's daemon
  // still listening on the same port, answering every call exactly like the
  // right one — until it is asked for a handler it does not have, or writes a
  // schema it does not know. The version string is the only way to see it, which
  // is why the app and the engine are built from one number.
  //
  // Not `danger`: everything still works, and pretending otherwise over what is
  // usually a five-second fix would be the boy who cried wolf. But it does not
  // resolve on its own, and nothing else in the window would ever mention it.
  const shellVersion = appVersion()
  if (status === "open" && engine !== null && shellVersion !== null && engine.version !== shellVersion) {
    notices.push({
      id: "engine-version",
      tone: "warning",
      title: "The engine is from a different version of Matisa",
      detail: `The app is ${shellVersion}, the running engine is ${engine.version}. Restarting stops everything it supervises.`,
      actions: [
        {
          label: "Restart engine",
          onClick: () => {
            setRestarting(true)
            void restartEngine().finally(() => setRestarting(false))
          },
          primary: true,
          // The one place here that tracks a flag rather than live state: a
          // restart spans a shutdown and a spawn with a closed socket in the
          // middle, so there is no single field that is true for exactly as
          // long as it is running.
          busy: restarting
        }
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

  // An update is downloaded and waiting. It is never applied on its own — not on
  // a timer and not on quit — because applying stops the engine, and stopping
  // the engine stops every project it supervises. That is the user's call to
  // make, and the detail line says so rather than leaving them to discover it.
  //
  // The order of the two steps is the whole design: the engine is asked to go
  // FIRST, and the shell refuses to swap the bundle until the port is actually
  // closed. Skip that and the new build inherits the old daemon — the exact
  // condition the notice above exists to report.
  if (update.phase === "ready") {
    notices.push({
      id: "update",
      tone: "info",
      title: `Matisa ${update.version} is ready to install`,
      detail: "Applying restarts Matisa and stops everything the engine is running.",
      actions: [
        {
          label: "Install and restart",
          onClick: () => {
            setApplying(true)
            void (async () => {
              await shutdownEngine()
              const result = await applyUpdate()
              // On success the app is already on its way out, so there is no
              // state to put back — only a failure ever returns to this window.
              if (!result.ok) {
                toast.error("The update was not applied", { description: result.reason })
                setApplying(false)
              }
            })()
          },
          primary: true,
          busy: applying
        }
      ]
    })
  }

  // The CLI is shipped inside the bundle but nothing puts it on PATH, so a
  // fresh download leaves `matisa guide` — the first command anyone is told to
  // run — not found. Nothing else in the window would ever mention that, and the
  // user has no reason to suspect a command they were told exists does not.
  //
  // Last in the strip and `info`, because nothing is broken: the window works
  // fully without the link. It stays until the link exists, like the update
  // notice, because it describes a condition that does not resolve on its own —
  // and it is derived from a live check, so linking by hand in a terminal
  // clears it on the next focus without a restart.
  if (cli !== null && cli.supported && !cli.installed) {
    notices.push({
      id: "cli",
      tone: "info",
      title: "The matisa command isn't on your PATH",
      // Names the password up front. An admin prompt nobody was expecting is
      // the thing that makes a person cancel and not try again.
      detail: "Link it into /usr/local/bin — that needs your password — and matisa guide works in any terminal.",
      actions: [
        {
          label: "Install now",
          onClick: () => {
            setLinking(true)
            void installCli()
              .then((result) => {
                if (result.ok) {
                  toast.success("The matisa command is installed", {
                    description: `Linked at ${result.path}. Run matisa guide in any terminal.`
                  })
                  recheckCli()
                  return
                }
                // A dismissed password prompt is the user declining, not a
                // failure — telling them it went wrong would be arguing.
                if (result.cancelled !== true) {
                  toast.error("The command was not installed", { description: result.reason })
                }
              })
              .finally(() => setLinking(false))
          },
          primary: true,
          busy: linking
        },
        {
          // For the machine whose admin prompt is managed away, and for the
          // user who would rather see what is about to run as root.
          label: "Copy command",
          onClick: () => {
            void navigator.clipboard?.writeText(cli.command)
            toast.success("Command copied", { description: "Paste it into a terminal." })
          }
        }
      ]
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
          {/* An alarm glyph on a notice that is not an alarm is how the strip
              stops being read. The update wears the download mark, and the CLI
              notice the terminal it is about — both are `info`, and the glyph is
              the only thing that tells them apart at a glance. */}
          <span className="banner-ico">
            {n.id === "cli" ? (
              <Icons.Terminal size={14} />
            ) : n.tone === "info" ? (
              <Icons.ArrowDownCircle size={14} />
            ) : (
              <Icons.Alert size={14} />
            )}
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
