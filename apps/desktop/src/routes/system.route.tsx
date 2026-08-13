import { useState } from "react"
import { useNavigate, useParams } from "@tanstack/react-router"
import type { ForeignClaim, ProjectId, RuntimeState, UnmanagedEntry } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { useUi } from "~/store/store.ui"
import { systemKeyOf, SYSTEM_IDS, type SystemKey } from "~/store/store.systems"
import { Icons } from "~/components/icons"
import { ConfirmDialog } from "~/components/forms/confirm"
import { formatUptime, KillButton, Spinner, StatusFigure, useLatestFailure } from "~/components/primitives"
import { engineUrl } from "~/rpc/rpc.client"

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
 *  than one click away, and the full record a button press behind it. */
const ProblemLine = ({ systemId }: { systemId: ProjectId }) => {
  const failure = useLatestFailure(systemId)
  const openDrawer = useUi((s) => s.openDrawer)
  if (failure === undefined) return null

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
            <button className="ico-btn" title="Refresh the catalog" disabled={!up} onClick={() => void refreshCatalog()}>
              <Icons.Refresh size={15} />
            </button>
          </div>
        </div>

        <div className="hero-url-row">
          <div className="sys-facts">
            <Fact label="socket" value={engineUrl()} />
            {engine !== null && (
              <>
                <Fact label="version" value={engine.version} />
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

      <ProblemLine systemId={SYSTEM_IDS.engine} />

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

      <ProblemLine systemId={SYSTEM_IDS.docker} />

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

// ────────────────────────────────────────────────────────────────────────────
// Discovery — the pane for everything matisa did NOT start.
//
// Two lists, and the order between them is the design. Claims come first
// because each one is a decision waiting on the user: a project of theirs is
// up and this engine is not running it. Unmanaged rows come second because
// they are inventory — worth seeing, rarely worth acting on.
//
// The evidence is shown, not summarised away. "Reclaim" and "Force reclaim"
// are the same call; which one a claim gets depends on whether the holder is
// demonstrably that project (its working directory is inside the project
// root), and the button says so rather than making the user infer it.
// ────────────────────────────────────────────────────────────────────────────

const ClaimRow = ({ claim }: { claim: ForeignClaim }) => {
  const takeover = useEngine((s) => s.takeover)
  const pending = useEngine((s) => s.pending[claim.projectId])
  const [confirming, setConfirming] = useState(false)
  const weak = claim.evidence === "port"

  return (
    <div className={`disc-claim ${weak ? "weak" : ""}`}>
      <div className="disc-claim-head">
        <Icons.Alert size={14} sw={2.2} />
        <span className="disc-claim-name">{claim.projectName}</span>
        <span className="disc-claim-holder mono">{claim.holder}</span>
        {claim.port !== undefined && <span className="disc-chip mono">:{claim.port}</span>}
        {claim.pid !== undefined && <span className="disc-chip mono">pid {claim.pid}</span>}
      </div>
      <div className="disc-claim-msg">{claim.message}</div>
      {claim.cwd !== undefined && (
        <div className="disc-claim-cwd mono" title={claim.cwd}>
          {claim.cwd}
        </div>
      )}
      <div className="disc-claim-actions">
        {pending !== undefined ? (
          <button className="btn sm" disabled>
            <Spinner size={12} /> Reclaiming…
          </button>
        ) : weak ? (
          <button
            className="btn sm danger"
            title="Nothing links this process to the project except the port number"
            onClick={() => setConfirming(true)}
          >
            Force reclaim
          </button>
        ) : (
          <button className="btn sm" onClick={() => void takeover(claim.projectId)}>
            Reclaim
          </button>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Force reclaim ${claim.projectName}?`}
          confirmLabel="Stop it and start mine"
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            void takeover(claim.projectId, true)
            setConfirming(false)
          }}
        >
          {claim.holder} (pid {claim.pid}) will be stopped, and it is not recognisable as{" "}
          {claim.projectName}
          {claim.cwd === undefined ? "" : ` — it is running in ${claim.cwd}`}. This cannot be undone;
          whatever that process was doing is lost.
        </ConfirmDialog>
      )}
    </div>
  )
}

const UnmanagedRow = ({ entry }: { entry: UnmanagedEntry }) => {
  const stopUnmanaged = useEngine((s) => s.stopUnmanaged)
  const startUnmanaged = useEngine((s) => s.startUnmanaged)

  return (
    <div className="disc-row">
      <StatusFigure state={entry.running ? "unmanaged" : "idle"} size={14} dotSize={7} />
      <div className="disc-row-text">
        <div className="disc-row-name">
          {entry.displayName}
          {entry.port !== undefined && <span className="disc-chip mono">:{entry.port}</span>}
          <span className="disc-chip mono">{entry.ref}</span>
        </div>
        <div className="disc-row-detail mono" title={entry.detail}>
          {entry.detail}
        </div>
      </div>
      {entry.running ? (
        <button className="btn sm danger" title="Stop it" onClick={() => void stopUnmanaged(entry.ref)}>
          Stop
        </button>
      ) : (
        // Only containers reach here: a stopped process has no command left to
        // re-run, so discovery never lists one.
        <button className="btn sm" title="Start it" onClick={() => void startUnmanaged(entry.ref)}>
          Start
        </button>
      )}
    </div>
  )
}

const DiscoveryPane = () => {
  const snapshot = useEngine((s) => s.discovery)
  const sweeping = useEngine((s) => s.discoverySweeping)
  const refreshDiscovery = useEngine((s) => s.refreshDiscovery)

  const claims = snapshot?.claims ?? []
  const unmanaged = snapshot?.unmanaged ?? []
  const state: RuntimeState = sweeping ? "starting" : claims.length > 0 ? "errored" : "idle"

  return (
    <>
      <div className="hero">
        <div className="hero-top">
          <div className="hero-id">
            <span className="hero-icon">
              <Icons.Search size={22} />
            </span>
            <div className="hero-id-text">
              <div className="hero-status-row">
                <StatusFigure state={state} size={16} dotSize={8} />
                <span className={`hero-status-label ${state}`}>
                  {sweeping
                    ? "sweeping"
                    : snapshot === null
                      ? "never swept"
                      : claims.length > 0
                        ? `${claims.length} outside matisa`
                        : "nothing unaccounted for"}
                </span>
              </div>
              <h1 className="hero-name">
                Discovery
                <span className="hero-kind">
                  <Icons.Broadcast size={11} />
                  system
                </span>
              </h1>
            </div>
          </div>

          <div className="hero-top-actions">
            <button
              className="ico-btn"
              title="Sweep again"
              disabled={sweeping}
              onClick={() => void refreshDiscovery(true)}
            >
              {sweeping ? <Spinner size={14} /> : <Icons.Refresh size={15} />}
            </button>
          </div>
        </div>

        <div className="hero-url-row">
          <div className="sys-facts">
            <Fact
              label="swept"
              value={snapshot === null ? "never" : new Date(snapshot.takenAt).toLocaleTimeString()}
              mono={false}
            />
            <Fact
              label="docker"
              value={snapshot?.dockerDaemonRunning === true ? "running" : "down"}
              mono={false}
            />
            <Fact label="unmanaged" value={String(unmanaged.length)} />
          </div>
        </div>
      </div>

      <section className="card open">
        <header className="card-head">
          <span className="card-toggle static">
            <Icons.Alert size={14} />
            <span className="card-title">Running outside matisa</span>
          </span>
        </header>
        <div className="card-body">
          {claims.length === 0 ? (
            <div className="card-empty">
              {/* The distinction matters: "we looked and found nothing" is not
                  the same claim as "we have not looked". */}
              {snapshot === null
                ? "Not swept yet — press refresh to look."
                : "Every configured project is either at rest or running under this engine."}
            </div>
          ) : (
            <div className="disc-claims">
              {claims.map((c) => (
                <ClaimRow key={`${c.projectId}:${c.pid ?? c.holder}`} claim={c} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="card open">
        <header className="card-head">
          <span className="card-toggle static">
            <Icons.Grid size={14} />
            <span className="card-title">Unmanaged</span>
          </span>
        </header>
        <div className="card-body">
          {unmanaged.length === 0 ? (
            <div className="card-empty">
              {snapshot === null
                ? "Not swept yet."
                : "Nothing else on this machine looks like a dev server or a container of yours."}
            </div>
          ) : (
            <div className="disc-rows">
              {unmanaged.map((u) => (
                <UnmanagedRow key={u.ref} entry={u} />
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
  return (
    <main className="main">
      {key === "engine" ? <EnginePane /> : key === "docker" ? <DockerPane /> : <DiscoveryPane />}
    </main>
  )
}
