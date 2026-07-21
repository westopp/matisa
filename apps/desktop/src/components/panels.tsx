import { useEffect, useRef, useState, type ReactNode } from "react"
import { Collapsible } from "@westopp/react-collapsible"
import {
  BASE_CONTEXT_ID,
  ContextId,
  type EnvContext,
  type NamedCommand,
  type ProjectWithState
} from "@matisa/core"
import { useCommandRunner, type CommandStatus } from "~/hooks/use-command-run"
import { useProjectCommands } from "~/hooks/use-project-commands"
import { useLifecycleState } from "~/hooks/use-lifecycle-state"
import { useEngine } from "~/store/store.engine"
import { Icons } from "./icons"
import { COLLAPSE_DURATION, commandLine, LifecycleButton, Spinner } from "./primitives"
import { SetCommandDialog, SetEnvVarDialog } from "./forms/lazy"
import { ConfirmDialog } from "./forms/confirm"

// ────────────────────────────────────────────────────────────────────────────
// The detail cards: what environment a project runs with, what named commands
// it has, and why it last failed. Both editable cards collapse — a project with
// forty variables should not push its terminals off the screen.
// ────────────────────────────────────────────────────────────────────────────

const maskIfSecret = (value: string, secret: boolean): string =>
  secret ? "•".repeat(Math.min(12, Math.max(4, value.length))) : value

/** Card shell: a header that toggles, and a body that animates open/closed.
 *  The toggle is the TITLE, not the whole header — the header also carries pills
 *  and buttons, and clicking those must not collapse the card underneath them. */
const CollapsibleCard = ({
  id,
  icon,
  title,
  head,
  actions,
  children
}: {
  id: string
  icon: ReactNode
  title: string
  head?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) => {
  const [open, setOpen] = useState(true)

  return (
    <section className={`card ${open ? "open" : "closed"}`}>
      <header className="card-head">
        <button
          className="card-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={id}
        >
          <span className="card-caret">
            {open ? <Icons.ChevronDown size={12} sw={2} /> : <Icons.ChevronRight size={12} sw={2} />}
          </span>
          {icon}
          <span className="card-title">{title}</span>
        </button>
        {head}
        <span style={{ flex: 1 }} />
        {actions}
      </header>
      <Collapsible id={id} open={open} transitionDuration={COLLAPSE_DURATION} initialOpen>
        <div className="card-body">{children}</div>
      </Collapsible>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Environment pills.
//
// `base` is not a context like the others — it is the floor every environment
// inherits — so its pill is not renameable and not deletable. The rest can be
// added inline (a dotted pill that becomes a field), renamed in place, and
// deleted, which takes their variables with them and so asks first.
// ────────────────────────────────────────────────────────────────────────────

const PillEditor = ({
  initial,
  placeholder,
  onCommit,
  onCancel
}: {
  initial: string
  placeholder: string
  onCommit: (name: string) => void
  onCancel: () => void
}) => {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => ref.current?.select(), [])

  const commit = (): void => {
    const trimmed = value.trim()
    if (trimmed === "") onCancel()
    else onCommit(trimmed)
  }

  return (
    <span className="env-pill editing">
      <input
        ref={ref}
        className="env-pill-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        size={Math.max(placeholder.length, value.length, 8)}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
          if (e.key === "Escape") onCancel()
        }}
      />
      <button className="env-pill-ico ok" title="Save" onClick={commit}>
        <Icons.Check size={12} sw={2.4} />
      </button>
      <button className="env-pill-ico cancel" title="Cancel" onClick={onCancel}>
        <Icons.X size={12} sw={2.4} />
      </button>
    </span>
  )
}

const EnvPills = ({
  project,
  contexts,
  disabled
}: {
  project: ProjectWithState
  contexts: ReadonlyArray<EnvContext>
  disabled: boolean
}) => {
  const activateContext = useEngine((s) => s.activateContext)
  const createContext = useEngine((s) => s.createContext)
  const renameContext = useEngine((s) => s.renameContext)
  const removeContext = useEngine((s) => s.removeContext)

  const [editing, setEditing] = useState<"new" | string | null>(null)
  const [confirming, setConfirming] = useState<EnvContext | null>(null)

  const base = contexts.find((c) => c.id === BASE_CONTEXT_ID)
  const others = contexts.filter((c) => c.id !== BASE_CONTEXT_ID)
  // No active context means the project runs on base alone, so that is what the
  // selected state has to show.
  const activeId = project.activeContextId ?? BASE_CONTEXT_ID

  const select = (id: string): void => {
    if (!disabled) void activateContext(project.id, ContextId.make(id))
  }

  return (
    <>
      <div className="env-pills">
        <button
          className={`env-pill ${activeId === BASE_CONTEXT_ID ? "active" : ""}`}
          onClick={() => select(BASE_CONTEXT_ID)}
          disabled={disabled}
          title="Applies to every environment"
        >
          <span className="env-pill-name">base</span>
          <span className="tab-count">{base?.vars.length ?? 0}</span>
        </button>

        {others.map((c) =>
          editing === c.id ? (
            <PillEditor
              key={c.id}
              initial={c.name}
              placeholder="name"
              onCancel={() => setEditing(null)}
              onCommit={(name) => {
                setEditing(null)
                if (name !== c.name) void renameContext(ContextId.make(c.id), name)
              }}
            />
          ) : (
            <span key={c.id} className={`env-pill ${activeId === c.id ? "active" : ""} ${disabled ? "disabled" : ""}`}>
              <button className="env-pill-main" onClick={() => select(c.id)} disabled={disabled}>
                <span className="env-pill-name">{c.name}</span>
                <span className="tab-count">{c.vars.length}</span>
              </button>
              <span className="env-pill-tools">
                <button
                  className="env-pill-ico"
                  title={`Rename ${c.name}`}
                  disabled={disabled}
                  onClick={() => setEditing(c.id)}
                >
                  <Icons.Edit size={11} />
                </button>
                <button
                  className="env-pill-ico danger"
                  title={`Delete ${c.name}`}
                  disabled={disabled}
                  onClick={() => setConfirming(c)}
                >
                  <Icons.Trash size={11} />
                </button>
              </span>
            </span>
          )
        )}

        {editing === "new" ? (
          <PillEditor
            initial=""
            placeholder="environment"
            onCancel={() => setEditing(null)}
            onCommit={(name) => {
              setEditing(null)
              void createContext(name)
            }}
          />
        ) : (
          <button className="env-pill add" onClick={() => setEditing("new")} disabled={disabled}>
            <Icons.Plus size={11} sw={2} />
            add environment
          </button>
        )}
      </div>

      {confirming !== null && (
        <ConfirmDialog
          title={`Delete "${confirming.name}"?`}
          confirmLabel="Delete environment"
          danger
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const target = confirming
            setConfirming(null)
            void removeContext(ContextId.make(target.id))
          }}
        >
          <p>
            This deletes the <strong>{confirming.name}</strong> environment and its{" "}
            {confirming.vars.length === 1 ? "1 variable" : `${confirming.vars.length} variables`}.
          </p>
          <p className="confirm-sub">
            Projects using it fall back to base. Base variables are not touched.
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}

export const EnvironmentCard = ({ project }: { project: ProjectWithState }) => {
  const contexts = useEngine((s) => s.contexts)
  const [adding, setAdding] = useState(false)
  // A project mid-transition already has its environment resolved; changing it
  // now would silently not apply to the run that is starting.
  const { busy } = useLifecycleState(project)

  const base = contexts.find((c) => c.id === BASE_CONTEXT_ID)
  // Pointing a project AT base means "base only" — there is no overlay. Without
  // this, base layers over itself and every one of its vars reads "overridden".
  const active =
    project.activeContextId === undefined || project.activeContextId === BASE_CONTEXT_ID
      ? undefined
      : contexts.find((c) => c.id === project.activeContextId)

  // Base first, then the active context on top — the same order the engine
  // applies them, so what is shown IS what the process will get.
  const rows = [
    ...(base?.vars ?? []).map((v) => ({ ...v, layer: "base" as const })),
    ...(active?.vars ?? []).map((v) => ({ ...v, layer: "context" as const }))
  ]
  const overridden = new Set(
    (base?.vars ?? []).filter((b) => (active?.vars ?? []).some((a) => a.key === b.key)).map((b) => b.key)
  )

  return (
    <>
      <CollapsibleCard
        id={`env-${project.id}`}
        icon={<Icons.Key size={14} />}
        title="Environment"
        head={<EnvPills project={project} contexts={contexts} disabled={busy} />}
        actions={
          <button className="btn sm" onClick={() => setAdding(true)} disabled={busy}>
            <Icons.Plus size={12} /> Variable
          </button>
        }
      >
        {rows.length === 0 ? (
          <div className="card-empty">No variables. Base variables apply to every environment.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: "34%" }}>Key</th>
                <th>Value</th>
                <th style={{ width: 110 }}>Layer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={`${v.layer}:${v.key}`} style={overridden.has(v.key) && v.layer === "base" ? { opacity: 0.45 } : undefined}>
                  <td className="mono">{v.key}</td>
                  <td className="mono">{maskIfSecret(v.value, v.secret)}</td>
                  <td>
                    <span className={`tag ${v.layer === "base" ? "base" : "ctx"}`}>
                      {v.layer === "base" ? (overridden.has(v.key) ? "overridden" : "base") : (active?.name ?? "context")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CollapsibleCard>

      {adding && (
        <SetEnvVarDialog
          contexts={contexts}
          initialContextId={project.activeContextId ?? BASE_CONTEXT_ID}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  )
}

/** The run control for one named command: play when it is not up, stop when it
 *  is, a spinner while the engine is opening the session. Same three states,
 *  same slot, as the project's own lifecycle button. */
const CommandRunButton = ({ status, onRun, onStop }: { status: CommandStatus; onRun: () => void; onStop: () => void }) => {
  if (status === "starting") {
    return (
      <button className="ico-primary busy" title="Starting…" disabled>
        <Spinner size={11} />
      </button>
    )
  }
  return status === "running" ? (
    <button className="ico-primary danger" title="Interrupt (Ctrl-C)" onClick={onStop}>
      <Icons.Stop size={13} />
    </button>
  ) : (
    <button className="ico-primary success" title="Run" onClick={onRun}>
      <Icons.Play size={13} />
    </button>
  )
}

export const CommandsCard = ({ project }: { project: ProjectWithState }) => {
  const removeCommand = useEngine((s) => s.removeCommand)
  const [editing, setEditing] = useState<NamedCommand | "new" | null>(null)
  const { busy } = useLifecycleState(project)

  const list = useProjectCommands(project.id)
  const { statusOf, run, stop } = useCommandRunner(project.id)

  return (
    <>
      <CollapsibleCard
        id={`commands-${project.id}`}
        icon={<Icons.Terminal size={14} />}
        title="Commands"
        actions={
          <button className="btn sm" onClick={() => setEditing("new")} disabled={busy}>
            <Icons.Plus size={12} /> Command
          </button>
        }
      >
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 44 }} />
              <th style={{ width: "22%" }}>Name</th>
              <th>Command</th>
              <th style={{ width: 80 }}>Env</th>
              <th style={{ width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {/* The supervised command is a command like any other, and the one
                run most often — so it leads the table. It is edited through the
                project itself, which is why it carries no row actions. */}
            <tr className="tbl-primary">
              <td>
                <LifecycleButton project={project} size={13} />
              </td>
              <td className="mono">{project.name}</td>
              <td className="mono trunc" title={commandLine(project)}>
                {commandLine(project)}
              </td>
              <td>
                <span className="tag base">main</span>
              </td>
              <td />
            </tr>
            {list.map((c) => (
              <tr key={c.name}>
                <td>
                  <CommandRunButton
                    status={statusOf(c.name)}
                    onRun={() => void run(c.name, c.command)}
                    onStop={() => stop(c.name)}
                  />
                </td>
                <td className="mono">{c.name}</td>
                <td className="mono trunc" title={c.command}>
                  {c.command}
                </td>
                <td>{c.vars.length > 0 && <span className="tag">{c.vars.length} vars</span>}</td>
                <td>
                  <span className="row-actions">
                    <button className="ico" title="Edit" onClick={() => setEditing(c)} disabled={busy}>
                      <Icons.Edit size={13} />
                    </button>
                    <button
                      className="ico danger-hover"
                      title="Remove"
                      disabled={busy}
                      onClick={() => void removeCommand(project.id, c.name)}
                    >
                      <Icons.Trash size={13} />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CollapsibleCard>

      {editing !== null && (
        <SetCommandDialog
          projectId={project.id}
          existing={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

export const FailuresCard = ({ project }: { project: ProjectWithState }) => {
  // Narrow in render, not in the selector: a selector that returns a fresh
  // array on every read makes useSyncExternalStore see a new snapshot each time.
  const all = useEngine((s) => s.failures)
  const failures = all.filter((f) => f.projectId === project.id)
  if (failures.length === 0) return null

  return (
    <section className="card">
      <header className="card-head">
        <Icons.XCircle size={14} />
        <span className="card-title">Recent failures</span>
        <span className="tab-count">{failures.length}</span>
      </header>
      <div className="card-body">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 160 }}>When</th>
              <th style={{ width: 90 }}>Exit</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {failures.map((f) => (
              <tr key={`${f.ts}-${f.exitCode ?? f.signal ?? ""}`}>
                <td className="mono">{new Date(f.ts).toLocaleString()}</td>
                <td className="mono">{f.signal ?? f.exitCode ?? "—"}</td>
                <td>
                  <div>{f.summary ?? "exited unexpectedly"}</div>
                  {f.logTail !== undefined && (
                    <pre className="log-tail">
                      {f.logTail}
                    </pre>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
