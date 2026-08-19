import { useEffect, useState } from "react"
import type { NotificationPrefs, ProjectId } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { inShell, setWindowTranslucent, windowTranslucent } from "~/lib/native"
import { Icons } from "../icons"
import { Dialog } from "./dialog"

// ────────────────────────────────────────────────────────────────────────────
// Settings — everything global, in the one place a person looks for it.
//
// The document lives in the engine, not in this window: the CLI reads the same
// operations instructions, and a second desktop window must not be able to hold
// a different idea of what they say. So this edits a LOCAL draft and saves it
// explicitly, rather than writing through on every keystroke — a text area that
// round-trips per character would fight the caret, and the engine broadcasts
// every write to every other client.
//
// The draft is seeded from the store and re-seeded whenever the saved document
// changes underneath (another client, or the save's own echo), except while
// there are unsaved edits — a background refresh must never eat what someone is
// halfway through typing.
// ────────────────────────────────────────────────────────────────────────────

const Toggle = ({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) => (
  <label className={`set-toggle ${disabled === true ? "off" : ""}`}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
    <span className="set-toggle-text">
      <span className="set-toggle-label">{label}</span>
      {hint !== undefined && <span className="field-hint">{hint}</span>}
    </span>
  </label>
)

// ── Appearance ──────────────────────────────────────────────────────────────
// The one control in this dialog that is not part of the draft. It writes
// through on the click because it IS its own preview: a translucency you cannot
// see until you press Save is one you have to guess at, and there is nothing to
// review afterwards.
//
// A switch rather than a dial. This is NSWindow alpha, so it fades the whole
// window including its text — which makes it defensible at one value slight
// enough to cost nothing and indefensible as a range the user can drag until
// the app stops being readable.
//
// Shell only. A browser tab has no window to fade, and a control that visibly
// does nothing is worse than one that is absent.
const Appearance = () => {
  const [translucent, setTranslucent] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    void windowTranslucent().then((on) => {
      if (live) setTranslucent(on)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <section className="set-section">
      <h3 className="set-title">Window</h3>
      <p className="set-blurb">
        Off by default, and the default is the honest one: the whole window
        fades, text included, so this is a look rather than a way to see what is
        behind Matisa while you work.
      </p>
      {translucent === null ? (
        <span className="field-hint">asking the window</span>
      ) : (
        <Toggle
          label="Translucent window"
          hint="lets the desktop through, slightly — applies now and on the next launch"
          checked={translucent}
          onChange={(next) => {
            setTranslucent(next)
            setWindowTranslucent(next)
          }}
        />
      )}
    </section>
  )
}

export const SettingsDialog = ({ onClose }: { onClose: () => void }) => {
  const settings = useEngine((s) => s.settings)
  const saveSettings = useEngine((s) => s.saveSettings)
  const projects = useEngine((s) => s.projects)
  const groups = useEngine((s) => s.groups)

  const [instructions, setInstructions] = useState(settings?.operationsInstructions ?? "")
  const [notifications, setNotifications] = useState<NotificationPrefs | null>(
    settings?.notifications ?? null
  )
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Re-seed from the engine, but never over an edit in progress.
  useEffect(() => {
    if (settings === null || dirty) return
    setInstructions(settings.operationsInstructions)
    setNotifications(settings.notifications)
  }, [settings, dirty])

  const prefs = notifications ?? settings?.notifications ?? null

  const editPrefs = (patch: Partial<NotificationPrefs>): void => {
    if (prefs === null) return
    setNotifications({ ...prefs, ...patch })
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await saveSettings({
        operationsInstructions: instructions,
        ...(prefs === null ? {} : { notifications: prefs })
      })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  // Hidden things are addressed here rather than where they were hidden — that
  // is the whole point of a hidden pile: the card is not on screen to unhide
  // itself from.
  const hiddenProjects = (settings?.hiddenProjects ?? []).map((id) => ({
    id,
    name: projects.find((p) => p.id === id)?.name ?? id
  }))
  const hiddenGroups = (settings?.hiddenGroups ?? []).map((slug) => ({
    slug,
    title: groups.find((g) => g.slug === slug)?.title ?? slug
  }))

  // Revealing writes through immediately rather than joining the draft: it is a
  // one-click action with nothing to review, and leaving it "unsaved" beside a
  // Save button that also commits the text area is two meanings for one button.
  const reveal = (patch: {
    projects?: ReadonlyArray<ProjectId>
    groups?: ReadonlyArray<string>
  }): void => {
    void saveSettings({
      ...(patch.projects === undefined ? {} : { hiddenProjects: patch.projects }),
      ...(patch.groups === undefined ? {} : { hiddenGroups: patch.groups })
    })
  }

  return (
    <Dialog
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <span className="field-hint" style={{ flex: 1 }}>
            {settings === null
              ? "the engine has not reported settings"
              : dirty
                ? "unsaved changes"
                : "saved"}
          </span>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
            <Icons.Check size={12} /> {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <section className="set-section">
        <h3 className="set-title">Operations instructions</h3>
        <p className="set-blurb">
          Handed verbatim to any agent that runs <code className="mono">matisa operations-instructions</code>.
          Matisa does not interpret or enforce what is in here — port ranges, naming rules, what an
          agent may start on its own. The guide tells agents to read it before they act; finer
          control belongs in your own agent file.
        </p>
        <textarea
          className="field-textarea mono"
          rows={9}
          value={instructions}
          placeholder={
            "e.g.\nUse ports 5700–5800 for anything you create.\nNever stop a project you did not start.\nAsk before adding a project to the catalog."
          }
          onChange={(e) => {
            setInstructions(e.target.value)
            setDirty(true)
          }}
        />
      </section>

      <section className="set-section">
        <h3 className="set-title">Notifications</h3>
        <p className="set-blurb">
          A toast while the window has focus; a system notification when it does not.
        </p>
        {prefs === null ? (
          <span className="field-hint">unavailable until the engine reports settings</span>
        ) : (
          <>
            <Toggle
              label="Notify me"
              hint="the master switch — off is silent, whatever is ticked below"
              checked={prefs.enabled}
              onChange={(enabled) => editPrefs({ enabled })}
            />
            <Toggle
              label="Crashes"
              hint="a project exited on its own"
              checked={prefs.crashed}
              disabled={!prefs.enabled}
              onChange={(crashed) => editPrefs({ crashed })}
            />
            <Toggle
              label="State changes"
              hint="started, stopped, restarted — usually something you just did"
              checked={prefs.stateChanged}
              disabled={!prefs.enabled}
              onChange={(stateChanged) => editPrefs({ stateChanged })}
            />
            <Toggle
              label="Health changes"
              hint="a running project stopped answering, or started again"
              checked={prefs.healthChanged}
              disabled={!prefs.enabled}
              onChange={(healthChanged) => editPrefs({ healthChanged })}
            />
            <Toggle
              label="Escalate when the window is not focused"
              hint="off keeps everything in-app, where you will miss it"
              checked={prefs.osWhenUnfocused}
              disabled={!prefs.enabled}
              onChange={(osWhenUnfocused) => editPrefs({ osWhenUnfocused })}
            />
          </>
        )}
      </section>

      {inShell() && <Appearance />}

      <section className="set-section">
        <h3 className="set-title">Hidden</h3>
        <p className="set-blurb">
          Out of the fleet, not out of matisa. Hidden projects still run, still count, and are still
          listed by the CLI — and a crash brings one back on screen regardless.
        </p>
        {hiddenProjects.length === 0 && hiddenGroups.length === 0 ? (
          <span className="field-hint">nothing is hidden</span>
        ) : (
          <div className="set-hidden">
            {hiddenGroups.map((g) => (
              <span className="set-hidden-row" key={g.slug}>
                <Icons.Stack size={12} />
                <span className="set-hidden-name">{g.title}</span>
                <button
                  className="btn sm"
                  onClick={() =>
                    reveal({ groups: hiddenGroups.filter((x) => x.slug !== g.slug).map((x) => x.slug) })
                  }
                >
                  Reveal
                </button>
              </span>
            ))}
            {hiddenProjects.map((p) => (
              <span className="set-hidden-row" key={p.id}>
                <Icons.Code size={12} />
                <span className="set-hidden-name">{p.name}</span>
                <button
                  className="btn sm"
                  onClick={() =>
                    reveal({ projects: hiddenProjects.filter((x) => x.id !== p.id).map((x) => x.id) })
                  }
                >
                  Reveal
                </button>
              </span>
            ))}
          </div>
        )}
      </section>
    </Dialog>
  )
}
