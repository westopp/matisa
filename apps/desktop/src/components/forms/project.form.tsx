import { useMemo, useState } from "react"
import { GeneratePgForm, pgf, usePgForm } from "@westopp/pgform"
import {
  GroupSlug,
  tokenize,
  type NewProject,
  type Port,
  type ProjectKind,
  type ProjectPatch,
  type ProjectWithState
} from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { checkDirectoryExists } from "~/store/store.picker"
import { Icons } from "../icons"
import { baseComponents } from "./form.components"
import { ConfirmDialog } from "./confirm"
import { Dialog } from "./dialog"

// ────────────────────────────────────────────────────────────────────────────
// The project form — one dialog for both add and edit.
//
// `kind` drives which of command/image/composeFile is shown AND required —
// mirroring the Schema.filter on NewProject in core. The engine still validates
// (it is authoritative), but requiring it here means the user is corrected in
// place instead of by a round-trip error.
//
// Editing does not offer `kind`: it decides which runner supervises the project
// and is not a field you change under a running process — delete and re-add.
// ────────────────────────────────────────────────────────────────────────────

const KIND_OPTIONS = [
  { label: "Process — a local dev server", value: "process" },
  { label: "Docker — a single container", value: "docker" },
  { label: "Compose — a whole stack", value: "compose" }
]

/** Show/require a field only for one project kind. */
const onlyForKind = (kind: ProjectKind) => ({
  hidden: {
    handler: (_field: unknown, form: { getValue: (k: string) => unknown }) => form.getValue("kind") !== kind,
    fieldDependencies: [],
    formDependencies: ["values.kind"]
  },
  required: {
    handler: (_field: unknown, form: { getValue: (k: string) => unknown }) =>
      form.getValue("kind") === kind
        ? ({ value: true, message: "Required for this kind" } as const)
        : ({ value: false } as const),
    fieldDependencies: [],
    formDependencies: ["values.kind"]
  }
})

const commandText = (project?: ProjectWithState): string =>
  project?.command === undefined ? "" : [project.command.program, ...project.command.args].join(" ")

const ProjectDialog = ({
  existing,
  onClose
}: {
  existing?: ProjectWithState
  onClose: () => void
}) => {
  const groups = useEngine((s) => s.groups)
  const addProject = useEngine((s) => s.addProject)
  const updateProject = useEngine((s) => s.updateProject)
  const removeProject = useEngine((s) => s.removeProject)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const editing = existing !== undefined

  const remove = async (): Promise<void> => {
    if (existing === undefined) return
    setSubmitting(true)
    try {
      if (await removeProject(existing.id)) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  // Group options are captured at open time; the dialog is mounted per-open.
  const fields = useMemo(
    () =>
      pgf.formData({
        name: {
          type: "text",
          required: { value: true, message: "Required" },
          defaultValue: existing?.name ?? "",
          metadata: { label: "Name", placeholder: "my-api" }
        },
        root: {
          type: "text",
          required: { value: true, message: "Required" },
          defaultValue: existing?.root ?? "",
          metadata: { label: "Root directory", placeholder: "/Users/me/dev/my-api", mono: true, browse: true }
        },
        kind: {
          type: "select",
          defaultValue: existing?.kind ?? "process",
          required: { value: true, message: "Required" },
          options: KIND_OPTIONS,
          metadata: {
            label: "Kind",
            ...(editing ? { readOnly: true, description: "Kind is fixed once a project exists." } : {})
          }
        },
        command: {
          type: "text",
          defaultValue: commandText(existing),
          ...onlyForKind("process"),
          metadata: {
            label: "Start command",
            placeholder: "npm run dev",
            mono: true,
            description: "Quoted arguments are preserved."
          }
        },
        image: {
          type: "text",
          defaultValue: existing?.image ?? "",
          ...onlyForKind("docker"),
          metadata: { label: "Image", placeholder: "postgres:16", mono: true }
        },
        composeFile: {
          type: "text",
          defaultValue: existing?.composeFile ?? "",
          ...onlyForKind("compose"),
          metadata: { label: "Compose file", placeholder: "/Users/me/dev/stack/docker-compose.yml", mono: true }
        },
        ports: {
          type: "number-array",
          defaultValue: existing?.ports.map((p) => p.number) ?? [],
          newItemDefault: 3000,
          metadata: { label: "Ports", description: "The first port is the one health is probed on." }
        },
        pathToIcon: {
          type: "text",
          defaultValue: existing?.pathToIcon ?? "",
          metadata: {
            label: "Icon",
            placeholder: "/Users/me/dev/my-api/icon.png",
            mono: true,
            pickFile: true,
            description: "PNG, SVG, JPEG or WebP. Shown instead of the generic kind glyph."
          }
        },
        groupSlug: {
          type: "select",
          defaultValue: existing?.groupSlug ?? "",
          options: groups.map((g) => ({ label: g.title, value: g.slug })),
          metadata: { label: "Group", placeholder: "Ungrouped" }
        }
      }),
    [groups, existing, editing]
  )

  const form = usePgForm(fields, {
    validationMode: "onBlur",
    validate: {
      // The tokenizer is the same one the engine's CLI path uses; an
      // unterminated quote must fail here rather than spawn a mangled child.
      commandParses: (api) => {
        const raw = api.getValue("command")
        if (api.getValue("kind") !== "process" || typeof raw !== "string" || raw.trim() === "") return null
        const tokens = tokenize(raw)
        if (tokens === null) return { field: "command", message: "Unterminated quote", code: "BAD_QUOTE" }
        if (tokens.length === 0) return { field: "command", message: "No program given", code: "EMPTY" }
        return null
      }
    },
    onSubmit: (values) => {
      void submit(values as Record<string, unknown>)
    }
  })

  const submit = async (values: Record<string, unknown>): Promise<void> => {
    const root = String(values["root"] ?? "").trim()

    // The field's own debounced check gives live feedback, but it's a UI nicety,
    // not a guarantee — a fast submit can land inside its debounce window. This
    // is the actual gate: nothing reaches the engine without a verified path.
    setSubmitting(true)
    try {
      const rootCheck = await checkDirectoryExists(root)
      if (!rootCheck.ok) {
        form.getFieldApi("root").addError({ message: rootCheck.message, code: "NOT_FOUND" })
        return
      }

      const kind = (existing?.kind ?? String(values["kind"] ?? "process")) as ProjectKind
      const rawPorts = Array.isArray(values["ports"]) ? (values["ports"] as Array<number>) : []
      const ports: ReadonlyArray<Port> = rawPorts
        .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535)
        .map((number) => ({ number, protocol: "tcp" as const }))

      const groupSlug = String(values["groupSlug"] ?? "")
      const name = String(values["name"] ?? "").trim()
      const pathToIcon = String(values["pathToIcon"] ?? "").trim()

      const command = (() => {
        if (kind !== "process") return undefined
        const tokens = tokenize(String(values["command"] ?? "")) ?? []
        const [program, ...args] = tokens
        if (program === undefined) return undefined
        return { name: "start", program, args }
      })()

      if (existing !== undefined) {
        // A patch says what changed; an emptied field is a deliberate CLEAR, so
        // it goes as null rather than being dropped as "unchanged".
        const patch = {
          name,
          root,
          ports,
          ...(command === undefined ? {} : { command }),
          ...(kind === "docker" ? { image: String(values["image"] ?? "").trim() } : {}),
          ...(kind === "compose" ? { composeFile: String(values["composeFile"] ?? "").trim() } : {}),
          groupSlug: groupSlug === "" ? null : GroupSlug.make(groupSlug),
          pathToIcon: pathToIcon === "" ? null : pathToIcon
        } as ProjectPatch

        if (await updateProject(existing.id, patch)) onClose()
        return
      }

      const payload = {
        name,
        root,
        kind,
        ports,
        ...(command === undefined ? {} : { command }),
        ...(kind === "docker" ? { image: String(values["image"] ?? "").trim() } : {}),
        ...(kind === "compose" ? { composeFile: String(values["composeFile"] ?? "").trim() } : {}),
        ...(groupSlug === "" ? {} : { groupSlug: GroupSlug.make(groupSlug) }),
        ...(pathToIcon === "" ? {} : { pathToIcon })
      } as NewProject

      if (await addProject(payload)) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      title={editing ? `Edit ${existing.name}` : "Add project"}
      onClose={onClose}
      footer={
        <>
          {/* Delete lives with edit, not on the row: removing a project is a
              decision you make while looking at what it is, and it must never
              be one pixel from the button you press to open it. */}
          {editing && (
            <button className="btn danger" disabled={submitting} onClick={() => setConfirmingDelete(true)}>
              <Icons.Trash size={12} /> Delete
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={submitting} onClick={() => void form.getFormApi().submit()}>
            {editing ? <Icons.Check size={12} /> : <Icons.Plus size={12} />}{" "}
            {submitting ? "Saving…" : editing ? "Save changes" : "Add project"}
          </button>
        </>
      }
    >
      <GeneratePgForm generateFormProps={form.generateFormProps} components={baseComponents} />

      {confirmingDelete && existing !== undefined && (
        <ConfirmDialog
          title={`Remove ${existing.name}?`}
          confirmLabel="Remove project"
          danger
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false)
            void remove()
          }}
        >
          It disappears from the catalog along with its commands. Files on disk are untouched — this removes the
          project from matisa, not from your machine.
          {existing.state === "running" && " It is running now; the engine stops it first."}
        </ConfirmDialog>
      )}
    </Dialog>
  )
}

export const AddProjectDialog = ({ onClose }: { onClose: () => void }) => <ProjectDialog onClose={onClose} />

export const EditProjectDialog = ({
  project,
  onClose
}: {
  project: ProjectWithState
  onClose: () => void
}) => <ProjectDialog existing={project} onClose={onClose} />
