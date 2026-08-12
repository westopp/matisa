import { useEffect, useRef, useState, type ReactNode } from "react"
import { Collapsible } from "@westopp/react-collapsible"
import {
  BASE_CONTEXT_ID,
  ContextId,
  type CommandVar,
  type EnvContext,
  type EnvVar,
  type NamedCommand,
  type ProjectWithState
} from "@matisa/core"
import { useCommandRunner } from "~/hooks/use-command-run"
import { useProjectCommands } from "~/hooks/use-project-commands"
import { useLifecycleState } from "~/hooks/use-lifecycle-state"
import { useEngine } from "~/store/store.engine"
import { Icons } from "./icons"
import { QuickMenu } from "./quick.commands"
import { COLLAPSE_DURATION, CommandRunButton, commandLine, LifecycleButton } from "./primitives"
import { SetCommandDialog, SetEnvVarDialog } from "./forms/lazy"
import { ConfirmDialog } from "./forms/confirm"

// ────────────────────────────────────────────────────────────────────────────
// The detail cards: what environment a project runs with, what named commands
// it has, and why it last failed. Both editable cards collapse — a project with
// forty variables should not push its terminals off the screen.
// ────────────────────────────────────────────────────────────────────────────

const maskIfSecret = (value: string, secret: boolean): string =>
  secret ? "•".repeat(Math.min(12, Math.max(4, value.length))) : value

/** A command's own overrides, as the tooltip behind its "n vars" tag. Nothing is
 *  masked: a command variable has no secret flag — the dialog that writes them
 *  offers none — so masking here would imply a protection that does not exist. */
const varsTooltip = (vars: ReadonlyArray<CommandVar>): string =>
  // Blank line under the heading: without it the first variable reads as a
  // continuation of the sentence rather than the start of the list.
  ["Command environment — applied on every run", "", ...vars.map((v) => `${v.key}=${v.value}`)].join("\n")


/** Card shell: a header that toggles, and a body that animates open/closed.
 *  The toggle is the TITLE, not the whole header — the header also carries pills
 *  and buttons, and clicking those must not collapse the card underneath them. */
export const CollapsibleCard = ({
  id,
  icon,
  title,
  head,
  actions,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  children
}: {
  id: string
  icon: ReactNode
  title: string
  head?: ReactNode
  actions?: ReactNode
  /** Closed by default. These cards are reference material — you open them to
   *  change something — and the terminals below are what the page is for. */
  defaultOpen?: boolean
  /** Hand the collapse to the caller. Only the Terminals card needs this: its
   *  state has to be reachable from wherever a process is started, and a card
   *  that owns its own boolean cannot be opened by anything but its header. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) => {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const open = controlled ?? uncontrolled

  const toggle = (): void => {
    if (onOpenChange === undefined) setUncontrolled(!open)
    else onOpenChange(!open)
  }

  return (
    <section className={`card ${open ? "open" : "closed"}`}>
      <header className="card-head">
        <button className="card-toggle" onClick={toggle} aria-expanded={open} aria-controls={id}>
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

// ────────────────────────────────────────────────────────────────────────────
// Environment, as stacked groups.
//
// Base and the active environment are each a collapsible GROUP: read-only
// KEY=value lines by default, flipped into an in-place editor by their own
// "edit variables" link (Save / cancel; one group edits at a time). base is
// the floor under every environment, so it is always shown; when an active
// environment redefines a base key, that base line is struck through — what
// you see struck is what the active layer wins at run time.
//
// The editor itself is a free-text `.env` block for the PLAIN vars: type
// KEY=value lines and Save parses + diffs them → add / change via env.set,
// DELETE a dropped line via env.unset. Secrets do not belong in free text
// (they mask; a masked value round-tripping a textarea would leak or
// self-destruct), so each is a row with its own Show toggle, added through the
// Variable dialog where the secret flag is explicit.
// ────────────────────────────────────────────────────────────────────────────

/** A valid POSIX-ish env key: letter/underscore start, then word chars. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const serialize = (vars: ReadonlyArray<EnvVar>): string => vars.map((v) => `${v.key}=${v.value}`).join("\n")

interface ParsedVar {
  readonly key: string
  readonly value: string
}

/** Parse a `.env` block. Blank lines and `#` comments are skipped; each kept
 *  line splits on its FIRST `=` so values may themselves contain `=`. */
const parseEnvText = (text: string): { vars: ParsedVar[]; errors: string[] } => {
  const vars: ParsedVar[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) return
    const eq = line.indexOf("=")
    if (eq < 0) {
      errors.push(`Line ${i + 1}: no “=” — write KEY=value`)
      return
    }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!KEY_RE.test(key)) {
      errors.push(`Line ${i + 1}: “${key || "(empty)"}” is not a valid key`)
      return
    }
    if (seen.has(key)) {
      errors.push(`Line ${i + 1}: “${key}” is set twice`)
      return
    }
    seen.add(key)
    vars.push({ key, value })
  })
  return { vars, errors }
}

/** A masked secret value with its own reveal eye. The global Show-all forces it
 *  open and locks the local toggle. */
const SecretValue = ({ value, revealAll }: { value: string; revealAll: boolean }) => {
  const [shown, setShown] = useState(false)
  const reveal = revealAll || shown
  return (
    <>
      <span className={`env-val ${reveal ? "" : "masked"}`}>{reveal ? value : maskIfSecret(value, true)}</span>
      <button
        className="ico xs"
        title={revealAll ? "Revealed by Show all" : reveal ? "Hide" : "Show"}
        disabled={revealAll}
        onClick={() => setShown((s) => !s)}
      >
        {reveal ? <Icons.EyeOff size={12} /> : <Icons.Eye size={12} />}
      </button>
    </>
  )
}

/** One read-only variable line: KEY = value, secrets masked with an eye. A
 *  `struck` line is a base var the active environment overrides. */
const ReadLine = ({ vv, struck, revealAll }: { vv: EnvVar; struck: boolean; revealAll: boolean }) => (
  <div className={`env-line ${struck ? "struck" : ""}`} title={struck ? "Overridden by the active environment" : undefined}>
    <span className="env-key">{vv.key}</span>
    <span className="env-eq">=</span>
    {vv.secret ? <SecretValue value={vv.value} revealAll={revealAll} /> : <span className="env-val">{vv.value}</span>}
  </div>
)

/** Edit mode for one group: the plain vars as a free-text `.env` block (Save
 *  parses + diffs → env.set / env.unset), secrets as masked rows kept out of the
 *  free text. Cancel lives in the group header. */
const GroupEditor = ({
  plainVars,
  secretVars,
  revealAll,
  disabled,
  onSave,
  onDeleteSecret
}: {
  plainVars: ReadonlyArray<EnvVar>
  secretVars: ReadonlyArray<EnvVar>
  revealAll: boolean
  disabled: boolean
  onSave: (
    upserts: ReadonlyArray<{ key: string; value: string; secret: boolean }>,
    removals: ReadonlyArray<string>
  ) => void
  onDeleteSecret: (key: string) => void
}) => {
  const [text, setText] = useState(serialize(plainVars))
  const { errors } = parseEnvText(text)

  const save = (): void => {
    const parsed = parseEnvText(text)
    if (parsed.errors.length > 0) return
    const current = new Map(plainVars.map((v) => [v.key, v.value]))
    const next = new Map(parsed.vars.map((v) => [v.key, v.value]))
    const upserts = parsed.vars
      .filter((v) => current.get(v.key) !== v.value)
      .map((v) => ({ key: v.key, value: v.value, secret: false }))
    const removals = [...current.keys()].filter((k) => !next.has(k))
    onSave(upserts, removals)
  }

  const rows = Math.min(16, Math.max(3, text.split("\n").length + 1))

  return (
    <div className="env-editor">
      <textarea
        className={`env-pad ${errors.length > 0 ? "invalid" : ""}`}
        value={text}
        rows={rows}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        placeholder={"KEY=value\nANOTHER_KEY=value"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            save()
          }
        }}
      />
      {errors.length > 0 && (
        <ul className="env-errors">
          {errors.map((er, i) => (
            <li key={i}>{er}</li>
          ))}
        </ul>
      )}
      {secretVars.length > 0 && (
        <div className="env-secrets">
          {secretVars.map((v) => (
            <div className="env-line secret" key={v.key}>
              <Icons.Key size={11} />
              <span className="env-key">{v.key}</span>
              <span className="env-eq">=</span>
              <SecretValue value={v.value} revealAll={revealAll} />
              <button
                className="ico xs danger-hover"
                title="Remove secret"
                disabled={disabled}
                onClick={() => onDeleteSecret(v.key)}
              >
                <Icons.Trash size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="env-editor-foot">
        <button className="btn sm primary" onClick={save} disabled={disabled || errors.length > 0}>
          Save variables
        </button>
      </div>
    </div>
  )
}

/** One environment as a collapsible group: read-only lines by default, an
 *  in-place editor when its edit link is toggled. Editing forces it open. */
const EnvGroup = ({
  context,
  label,
  isBase,
  overridden,
  editing,
  revealAll,
  disabled,
  defaultOpen,
  onEdit,
  onCancel,
  onSave,
  onDeleteSecret
}: {
  context: EnvContext
  label: string
  isBase: boolean
  overridden: ReadonlySet<string>
  editing: boolean
  revealAll: boolean
  disabled: boolean
  defaultOpen: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (
    upserts: ReadonlyArray<{ key: string; value: string; secret: boolean }>,
    removals: ReadonlyArray<string>
  ) => void
  onDeleteSecret: (key: string) => void
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const shown = open || editing

  return (
    <div className={`env-group ${editing ? "editing" : ""}`}>
      <div className="env-group-head">
        <button className="env-group-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={shown}>
          {shown ? <Icons.ChevronDown size={11} sw={2} /> : <Icons.ChevronRight size={11} sw={2} />}
          <span className="env-group-name">{label}</span>
          <span className="env-group-sub">variables</span>
          <span className="tab-count">{context.vars.length}</span>
        </button>
        <button className="link-btn" onClick={editing ? onCancel : onEdit} disabled={disabled && !editing}>
          {editing ? "cancel variables" : isBase ? "edit base variables" : "edit variables"}
        </button>
      </div>

      <Collapsible id={`env-grp-${context.id}`} open={shown} transitionDuration={COLLAPSE_DURATION}>
        <div className="env-group-body">
          {editing ? (
            <GroupEditor
              plainVars={context.vars.filter((v) => !v.secret)}
              secretVars={context.vars.filter((v) => v.secret)}
              revealAll={revealAll}
              disabled={disabled}
              onSave={onSave}
              onDeleteSecret={onDeleteSecret}
            />
          ) : context.vars.length === 0 ? (
            <div className="card-empty sm">No variables in {label}.</div>
          ) : (
            context.vars.map((v) => (
              <ReadLine key={v.key} vv={v} struck={overridden.has(v.key)} revealAll={revealAll} />
            ))
          )}
        </div>
      </Collapsible>
    </div>
  )
}

export const EnvironmentCard = ({ project }: { project: ProjectWithState }) => {
  const contexts = useEngine((s) => s.contexts)
  const applyEnvVars = useEngine((s) => s.applyEnvVars)
  const unsetEnvVar = useEngine((s) => s.unsetEnvVar)
  const [adding, setAdding] = useState(false)
  const [revealAll, setRevealAll] = useState(false)
  // Which group's editor is open (context id), if any — one at a time, mirroring
  // the wireframe's single highlighted box.
  const [editingId, setEditingId] = useState<string | null>(null)
  // A project mid-transition already has its environment resolved; editing now
  // would silently not apply to the run that is starting.
  const { busy } = useLifecycleState(project)

  const base = contexts.find((c) => c.id === BASE_CONTEXT_ID)
  const activeId = project.activeContextId ?? BASE_CONTEXT_ID
  const active = activeId === BASE_CONTEXT_ID ? undefined : contexts.find((c) => c.id === activeId)

  // Switching the active environment ends any in-place edit — the edited group
  // may no longer be on screen.
  useEffect(() => setEditingId(null), [activeId])

  // Base keys the active environment redefines are struck through in base: what
  // you see struck is what the active layer wins at run time.
  const overriddenInBase = new Set(
    (base?.vars ?? []).filter((b) => (active?.vars ?? []).some((a) => a.key === b.key)).map((b) => b.key)
  )

  const groups = [
    ...(base === undefined
      ? []
      : [
          {
            context: base,
            label: "base",
            isBase: true,
            overridden: overriddenInBase as ReadonlySet<string>,
            defaultOpen: active === undefined
          }
        ]),
    ...(active === undefined
      ? []
      : [
          {
            context: active,
            label: active.name,
            isBase: false,
            overridden: new Set<string>() as ReadonlySet<string>,
            defaultOpen: true
          }
        ])
  ]

  const commit = (
    contextId: ContextId,
    upserts: ReadonlyArray<{ key: string; value: string; secret: boolean }>,
    removals: ReadonlyArray<string>
  ): void => {
    void applyEnvVars(contextId, upserts, removals)
    setEditingId(null)
  }

  return (
    <>
      <CollapsibleCard
        id={`env-${project.id}`}
        icon={<Icons.Key size={14} />}
        title="Environment"
        head={<EnvPills project={project} contexts={contexts} disabled={busy} />}
        actions={
          <>
            <button
              className={`btn sm ${revealAll ? "active" : ""}`}
              onClick={() => setRevealAll((v) => !v)}
              title={revealAll ? "Hide secret values" : "Reveal every secret value"}
            >
              {revealAll ? <Icons.EyeOff size={12} /> : <Icons.Eye size={12} />} {revealAll ? "Hide all" : "Show all"}
            </button>
            <button className="btn sm" onClick={() => setAdding(true)} disabled={busy}>
              <Icons.Plus size={12} /> Variable
            </button>
          </>
        }
      >
        <div className="env-groups">
          {groups.map((g) => (
            <EnvGroup
              key={g.context.id}
              context={g.context}
              label={g.label}
              isBase={g.isBase}
              overridden={g.overridden}
              editing={editingId === g.context.id}
              revealAll={revealAll}
              disabled={busy}
              defaultOpen={g.defaultOpen}
              onEdit={() => setEditingId(g.context.id)}
              onCancel={() => setEditingId(null)}
              onSave={(u, r) => commit(g.context.id, u, r)}
              onDeleteSecret={(k) => void unsetEnvVar(g.context.id, k)}
            />
          ))}
        </div>
      </CollapsibleCard>

      {adding && (
        <SetEnvVarDialog contexts={contexts} initialContextId={ContextId.make(activeId)} onClose={() => setAdding(false)} />
      )}
    </>
  )
}

export const CommandsCard = ({ project }: { project: ProjectWithState }) => {
  const removeCommand = useEngine((s) => s.removeCommand)
  const [editing, setEditing] = useState<NamedCommand | "new" | null>(null)
  const [quick, setQuick] = useState<HTMLElement | null>(null)
  const { busy } = useLifecycleState(project)

  const list = useProjectCommands(project.id)
  const runner = useCommandRunner(project.id)
  const { statusOf, run, stop } = runner

  return (
    <>
      <CollapsibleCard
        id={`commands-${project.id}`}
        icon={<Icons.Terminal size={14} />}
        title="Commands"
        head={
          <>
            <button
              className="card-quick"
              title="Start or stop a command"
              onClick={(e) => {
                const el = e.currentTarget
                setQuick((open) => (open === null ? el : null))
              }}
            >
              <Icons.Play size={10} />
              <Icons.ChevronDown size={10} sw={2.4} />
            </button>
            {quick !== null && (
              <QuickMenu
                project={project}
                trigger={quick}
                runner={runner}
                onClose={() => setQuick(null)}
              />
            )}
          </>
        }
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
                <LifecycleButton project={project} size={18} />
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
                {/* Only the vars the command carries of its own — the project's
                    base and active environment are underneath every row and
                    saying so on each one would be noise. The count is the
                    headline; what they actually are is a hover away, because
                    "which override is this run getting" is the question the
                    count raises and cannot answer. */}
                <td>
                  {c.vars.length > 0 && (
                    <span className="tag" title={varsTooltip(c.vars)}>
                      {c.vars.length === 1 ? "1 var" : `${c.vars.length} vars`}
                    </span>
                  )}
                </td>
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
