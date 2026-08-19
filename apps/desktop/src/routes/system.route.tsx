import { useState } from "react"
import { useNavigate, useParams } from "@tanstack/react-router"
import type { ProjectId, RuntimeState } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { useUi } from "~/store/store.ui"
import { systemKeyOf, SYSTEM_IDS, type SystemKey } from "~/store/store.systems"
import { Icons } from "~/components/icons"
import { ConfirmDialog } from "~/components/forms/confirm"
import { formatUptime, KillButton, Spinner, StatusFigure, useLatestFailure } from "~/components/primitives"
import { engineUrl } from "~/rpc/rpc.client"
import { appVersion, inShell, revealEngineLog } from "~/lib/native"

// ────────────────────────────────────────────────────────────────────────────
// The detail pane for a system — the engine this client talks to, and the
// Docker daemon its containers need.
//
// Same shape as a project's pane on purpose: a status line, the facts as chips,
// the controls in the order they sit everywhere else. What differs is what
// there is to say. A system has no environment, no commands and no terminals,
// so it shows what it actually has — where it lives, how long it has been up,
// what it last refused to do — and says so plainly where it has nothing.
// ────────────────────────────────────────────────────────────────────────────

/** One labelled reading. The chip carries its own name because a system's facts
 *  are not guessable from their shape the way a port or a percentage is. */
const Fact = ({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) => (
  <span className="sys-fact" title={value}>
    <span className="sys-fact-label">{label}</span>
    <span className={`sys-fact-value ${mono ? "mono" : ""}`}>{value}</span>
  </span>
)

/** What this system last failed to do, if anything — the reason inline rather
 *  than one click away, and the full record a button press behind it.
 *
 *  Gated on the system being broken RIGHT NOW, not on a record existing. A
 *  system that has recovered has nothing to answer for: the record stays in the
 *  failures drawer, which is a history, but the pane speaks in the present. */
const ProblemLine = ({ systemId, broken }: { systemId: ProjectId; broken: boolean }) => {
  const failure = useLatestFailure(systemId)
  const openDrawer = useUi((s) => s.openDrawer)
  if (!broken || failure === undefined) return null

  return (
    <div className="sys-problem">
      <Icons.Alert size={14} sw={2.2} />
      <span className="sys-problem-text">{failure.summary ?? "failed"}</span>
      <button className="btn sm" onClick={() => openDrawer("failures")}>
        All failures
      </button>
    </div>
  )
}

const EnginePane = () => {
  const status = useEngine((s) => s.status)
  const engine = useEngine((s) => s.engine)
  const refreshCatalog = useEngine((s) => s.refreshCatalog)
  const shutdownEngine = useEngine((s) => s.shutdownEngine)
  const [confirming, setConfirming] = useState(false)

  const state: RuntimeState = status === "open" ? "running" : status === "connecting" ? "starting" : "crashed"
  const up = status === "open"

  return (
    <>
      <div className="hero">
        <div className="hero-top">
          <div className="hero-id">
            <span className="hero-icon">
              <Icons.Cpu size={22} />
            </span>
            <div className="hero-id-text">
              <div className="hero-status-row">
                <StatusFigure state={state} size={16} dotSize={8} />
                <span className={`hero-status-label ${state}`}>{status}</span>
                {up && <span className="hero-uptime">· uptime {formatUptime(engine?.startedAt)}</span>}
              </div>
              <h1 className="hero-name">
                Engine
                <span className="hero-kind">
                  <Icons.Broadcast size={11} />
                  system
                </span>
              </h1>
            </div>
          </div>

          <div className="hero-top-actions">
            {/* The engine writes to a file because it outlives whoever started
                it, so when it dies the reason is only ever there. Revealed
                rather than opened: the common next step is sending it to
                someone, not reading it here. Enabled while the engine is down —
                that is exactly when it is worth looking at. */}
            {inShell() && (
              <button className="ico-btn" title="Reveal the engine log in Finder" onClick={revealEngineLog}>
                <Icons.Logs size={15} />
              </button>
            )}
            <button className="ico-btn" title="Refresh the catalog" disabled={!up} onClick={() => void refreshCatalog()}>
              <Icons.Refresh size={15} />
            </button>
          </div>
        </div>

        <div className="hero-url-row">
          <div className="sys-facts">
            <Fact label="socket" value={engineUrl()} />
            {/* Both versions, side by side, because the interesting case is when
                they differ — the engine outlives the app, so after an update the
                daemon answering here may be the previous build's. The banner
                raises it; this is where you check it. */}
            {appVersion() !== null && <Fact label="app" value={appVersion() ?? ""} />}
            {engine !== null && (
              <>
                <Fact label="engine" value={engine.version} />
                <Fact label="pid" value={String(engine.pid)} />
                <Fact label="unix" value={engine.socketPath} />
                <Fact label="db" value={engine.dbPath} />
              </>
            )}
          </div>

          <div className="hero-actions">
            {/* Start is the one thing a renderer genuinely cannot do — the
                engine is what serves this page, so there is no channel left to
                ask over once it is down. Present and disabled, with the reason
                on it, rather than absent. */}
            <KillButton enabled={false} onKill={() => {}} title="The engine is not killable from here" size={16} />
            {status === "connecting" ? (
              <button className="ico-primary busy" title="Connecting…" disabled>
                <Spinner size={14} />
              </button>
            ) : up ? (
              <button className="ico-primary danger" title="Shut down the engine" onClick={() => setConfirming(true)}>
                <Icons.Stop size={18} />
              </button>
            ) : (
              <button
                className="ico-primary success"
                title="Start the engine from a terminal — nothing in this window can"
                disabled
              >
                <Icons.Play size={18} />
              </button>
            )}
          </div>
        </div>
      </div>

      <ProblemLine systemId={SYSTEM_IDS.engine} broken={status === "closed"} />

      <section className="card open">
        <header className="card-head">
          <span className="card-toggle static">
            <Icons.Stack size={14} />
            <span className="card-title">Modules</span>
          </span>
        </header>
        <div className="card-body">
          {engine === null ? (
            <div className="card-empty">
              {up ? "Waiting for the engine handshake." : "No connection — start the engine with `pnpm engine`."}
            </div>
          ) : (
            <div className="sys-modules">
              {engine.modulesFull.map((m) => (
                <span key={m} className="svc-chip">
                  {m}
                </span>
              ))}
              {engine.modulesStub.map((m) => (
                <span key={m} className="svc-chip stub" title="Stubbed — present, not implemented">
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {confirming && (
        <ConfirmDialog
          title="Shut down the engine?"
          confirmLabel="Shut down"
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            void shutdownEngine()
            setConfirming(false)
          }}
        >
          Every supervised project is stopped and this window loses its connection. Nothing here can start the
          engine again — you will need `pnpm engine` or the CLI.
        </ConfirmDialog>
      )}
    </>
  )
}

const DockerPane = () => {
  const daemon = useEngine((s) => s.daemon)
  const startDaemon = useEngine((s) => s.startDaemon)
  const stopDaemon = useEngine((s) => s.stopDaemon)
  const projects = useEngine((s) => s.projects)

  const state: RuntimeState =
    daemon.state === "running"
      ? "running"
      : daemon.state === "starting"
        ? "starting"
        : daemon.state === "start_failed"
          ? "errored"
          : "idle"

  const dependents = projects.filter((p) => p.kind === "docker" || p.kind === "compose")
  const moving = daemon.state === "starting"

  return (
    <>
      <div className="hero">
        <div className="hero-top">
          <div className="hero-id">
            <span className="hero-icon">
              <Icons.Docker size={22} />
            </span>
            <div className="hero-id-text">
              <div className="hero-status-row">
                <StatusFigure state={state} size={16} dotSize={8} />
                <span className={`hero-status-label ${state}`}>{daemon.state}</span>
              </div>
              <h1 className="hero-name">
                Docker
                <span className="hero-kind">
                  <Icons.Broadcast size={11} />
                  system
                </span>
              </h1>
            </div>
          </div>
        </div>

        <div className="hero-url-row">
          <div className="sys-facts">
            {/* The message the store has always held and no surface ever showed.
                It is the whole reason a `start_failed` is actionable. */}
            {daemon.message !== undefined && <Fact label="reason" value={daemon.message} mono={false} />}
            <Fact
              label="depends"
              value={`${dependents.length} ${dependents.length === 1 ? "project" : "projects"}`}
              mono={false}
            />
          </div>

          <div className="hero-actions">
            {moving ? (
              <button className="ico-primary busy" title="Starting…" disabled>
                <Spinner size={14} />
              </button>
            ) : daemon.state === "running" ? (
              <button className="ico-primary danger" title="Stop Docker" onClick={() => void stopDaemon()}>
                <Icons.Stop size={18} />
              </button>
            ) : (
              <button className="ico-primary success" title="Start Docker" onClick={() => void startDaemon()}>
                <Icons.Play size={18} />
              </button>
            )}
          </div>
        </div>
      </div>

      <ProblemLine systemId={SYSTEM_IDS.docker} broken={daemon.state === "start_failed"} />

      <section className="card open">
        <header className="card-head">
          <span className="card-toggle static">
            <Icons.Docker size={14} />
            <span className="card-title">Waiting on the daemon</span>
          </span>
        </header>
        <div className="card-body">
          {dependents.length === 0 ? (
            <div className="card-empty">No containers or stacks in the catalog.</div>
          ) : (
            <div className="sys-modules">
              {dependents.map((p) => (
                <span key={p.id} className="svc-chip">
                  {p.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  )
}

export const SystemRoute = () => {
  const { systemId } = useParams({ from: "/system/$systemId" })
  const navigate = useNavigate()
  const key: SystemKey | null = systemKeyOf(`sys:${systemId}`)

  if (key === null) {
    return (
      <main className="main">
        <div className="empty-state">
          <div className="empty-state-inner">
            <Icons.Search size={22} />
            <span>No such system.</span>
            <button className="btn sm" onClick={() => void navigate({ to: "/" })}>
              Back to the board
            </button>
          </div>
        </div>
      </main>
    )
  }

  // Nothing below the header: a system has no environment to layer, no commands
  // to name and no terminals to tile. Inventing empty cards for all three would
  // make the pane look broken rather than finished.
  return <main className="main">{key === "engine" ? <EnginePane /> : <DockerPane />}</main>
}
