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
  const projects = useEngine((s) => s.projects)
  const unmanaged = useEngine((s) => s.discovery?.unmanaged)
  const addProject = useEngine((s) => s.addProject)
  const updateProject = useEngine((s) => s.updateProject)
  const removeProject = useEngine((s) => s.removeProject)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const editing = existing !== undefined
  const initialKind: ProjectKind = existing?.kind ?? "process"

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
        // Process projects declare ONE port — a contract, not a hint: health is
        // probed on it and every stable/LAN URL reverse-proxies to it. Shown for
        // process, hidden (via the kind wrapper class) for docker/compose.
        port: {
          type: "number",
          defaultValue: existing?.ports[0]?.number ?? ("" as unknown as number),
          metadata: {
            label: "Port",
            placeholder: "3000",
            description:
              "Your app must run strictly on this port (e.g. --port 3000 with strictPort) — stable URLs and health checks depend on it."
          }
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
        // Decided here, not corrected afterwards: a project created with a URL
        // and switched off a second later has already been published under it.
        stableUrl: {
          type: "switch",
          defaultValue: existing?.stableUrl !== false,
          metadata: {
            label: "Stable URL",
            description:
              "Publish this project at http://<name>.localhost through Caddy. Its own http://localhost:<port> works either way, and sharing on the network is a separate switch."
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
      },
      // Ports are globally unique in the catalog — the engine enforces it with
      // a UNIQUE column and rejects the save. Saying so here, against the field,
      // is the difference between "fix this number" and a toast after the fact
      // that leaves the user re-reading a form they thought was finished.
      portFree: (api) => {
        const kind = (existing?.kind ?? api.getValue("kind")) as ProjectKind
        const raw =
          kind === "process"
            ? [Number(api.getValue("port"))]
            : ((api.getValue("ports") as Array<number> | undefined) ?? [])
        const field = kind === "process" ? "port" : "ports"
        for (const n of raw) {
          if (!Number.isInteger(n) || n <= 0) continue
          const owner = projects.find(
            (p) => p.id !== existing?.id && p.ports.some((x) => x.number === n)
          )
          if (owner !== undefined) {
            return { field, message: `Port ${n} belongs to ${owner.name}`, code: "PORT_TAKEN" }
          }
        }
        return null
      }
    },
    onSubmit: (values) => {
      void submit(values as Record<string, unknown>)
    }
  })

  // port ⇄ ports visibility. pgform's dynamic `hidden` handler never runs for
  // an ARRAY PARENT key (`ports`) — only its `ports[n]` items — so the
  // onlyForKind pattern can't drive it. Both fields stay registered (values
  // survive a kind switch, living in the pgform store); a wrapper class keyed
  // on the live kind hides the one that doesn't apply, purely in CSS.
  const kindValue = ((form.use("values.kind") as ProjectKind | "") || initialKind) as ProjectKind

  // Live, because it is watching a form value: the note appears as the number is
  // typed. Only foreign listeners are consulted — a port held by another PROJECT
  // is the hard error above, and reporting it twice in two tones would read as
  // two different problems.
  const typedPort = Number(form.use("values.port"))
  const occupied =
    kindValue === "process" && Number.isInteger(typedPort) && typedPort > 0
      ? unmanaged?.find((u) => u.port === typedPort && u.running)
      : undefined

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
      // process: the single `port` field; docker/compose: the `ports` array.
      const rawPorts =
        kind === "process"
          ? [Number(values["port"])]
          : Array.isArray(values["ports"])
            ? (values["ports"] as Array<number>)
            : []
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
          pathToIcon: pathToIcon === "" ? null : pathToIcon,
          stableUrl: values["stableUrl"] !== false
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
        ...(pathToIcon === "" ? {} : { pathToIcon }),
        ...(values["stableUrl"] === false ? { stableUrl: false } : {})
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
      <div className={`pf-kind-${kindValue}`}>
        <GeneratePgForm generateFormProps={form.generateFormProps} components={baseComponents} />
      </div>

      {/* Amber, below the fields, and never a blocker. A port that something is
          listening on RIGHT NOW is not invalid — it is a fact about the machine
          this minute, and it may well be the very app this project describes,
          started in a terminal. Refusing the save over it would be wrong; not
          mentioning it means finding out at the first Start. */}
      {occupied !== undefined && (
        <div className="pf-note">
          <Icons.Alert size={13} sw={2.2} />
          <span>
            Something is already listening on <b>:{occupied.port}</b> — {occupied.displayName}
            {occupied.pid === undefined ? "" : ` (pid ${occupied.pid})`}
            {occupied.cwd === undefined ? "" : ` in ${occupied.cwd}`}. Saving is fine; starting will not be
            until that port is free.
          </span>
        </div>
      )}

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
