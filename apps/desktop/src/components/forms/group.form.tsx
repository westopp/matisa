import { useState } from "react"
import type { Group, GroupSlug } from "@matisa/core"
import { GroupSlug as Slug } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { Icons } from "../icons"
import { Dialog } from "./dialog"

// ────────────────────────────────────────────────────────────────────────────
// Group create / rename. One field, because a group IS its title — everything
// else on the row (icon, description, notes) is optional metadata no one has
// asked to edit yet.
//
// The slug is derived from the title on CREATE and frozen thereafter: it is the
// key every project stores, so renaming a group must not silently re-key its
// members. Rename changes the label; the slug it was created under stays.
// ────────────────────────────────────────────────────────────────────────────

export const slugify = (title: string): string =>
  title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

export const GroupDialog = ({ existing, onClose }: { existing?: Group; onClose: () => void }) => {
  const setGroup = useEngine((s) => s.setGroup)
  const groups = useEngine((s) => s.groups)

  const [title, setTitle] = useState(existing?.title ?? "")
  const [saving, setSaving] = useState(false)

  const editing = existing !== undefined
  const slug = editing ? existing.slug : (slugify(title) as GroupSlug)
  const clash = !editing && slug !== "" && groups.some((g) => g.slug === slug)

  const invalid = title.trim() === "" || slug === "" || clash

  const save = async (): Promise<void> => {
    if (invalid) return
    setSaving(true)
    try {
      const ok = await setGroup({
        slug: Slug.make(slug),
        title: title.trim(),
        ...(existing?.description === undefined ? {} : { description: existing.description }),
        ...(existing?.notes === undefined ? {} : { notes: existing.notes }),
        ...(existing?.pathToIcon === undefined ? {} : { pathToIcon: existing.pathToIcon })
      })
      if (ok) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={editing ? `Rename ${existing.title}` : "New group"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={invalid || saving} onClick={() => void save()}>
            {editing ? <Icons.Check size={12} /> : <Icons.Plus size={12} />}{" "}
            {saving ? "Saving…" : editing ? "Rename" : "Create group"}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">Name</label>
        <input
          className="field-input"
          autoFocus
          value={title}
          placeholder="Demo Stack"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
        />
        <span className="field-hint mono">
          {slug === "" ? "slug derived from the name" : `slug: ${slug}`}
          {clash && " — already taken"}
          {editing && " (fixed — projects are keyed on it)"}
        </span>
      </div>
    </Dialog>
  )
}
