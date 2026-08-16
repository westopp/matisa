import { useMemo, useState } from "react"
import { GeneratePgForm, pgf, usePgForm } from "@westopp/pgform"
import { ContextId, type EnvContext } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { baseComponents } from "./form.components"
import { Dialog } from "./dialog"

// ────────────────────────────────────────────────────────────────────────────
// Environment variable editor.
//
// The layering the engine applies at spawn, lowest → highest:
//   project base → project active context → command base → command context
// So `base` is not a context like the others: it is the floor this PROJECT'S
// environments inherit. The UI says so explicitly rather than leaving it to be
// discovered — and says "this project", because a base that applied to every
// project is exactly the thing the schema no longer allows.
// ────────────────────────────────────────────────────────────────────────────

export const SetEnvVarDialog = ({
  contexts,
  initialContextId,
  onClose
}: {
  contexts: ReadonlyArray<EnvContext>
  initialContextId: string
  onClose: () => void
}) => {
  const setEnvVar = useEngine((s) => s.setEnvVar)
  const [submitting, setSubmitting] = useState(false)

  // Only the project's own contexts are offered; the caller passes them already
  // filtered. There is no synthesised "base" entry any more — a project's base
  // is a real row that exists from the moment the project does, so an option
  // pointing at a context that had yet to be created is no longer needed.
  const options = useMemo(
    () =>
      contexts.map((c) => ({
        label: c.isBase ? `${c.name} (applies to all of this project's environments)` : c.name,
        value: c.id as string
      })),
    [contexts]
  )

  const fields = useMemo(
    () =>
      pgf.formData({
        contextId: {
          type: "select",
          defaultValue: initialContextId,
          required: { value: true, message: "Required" },
          options,
          metadata: {
            label: "Context",
            description: "base applies to all of this project's environments; others override it."
          }
        },
        key: {
          type: "text",
          required: { value: true, message: "Required" },
          formatters: { onChange: ["trimmed"] },
          metadata: { label: "Key", placeholder: "DATABASE_URL", mono: true }
        },
        value: {
          type: "text",
          metadata: { label: "Value", placeholder: "postgres://…", mono: true, multiline: true }
        },
        secret: {
          type: "switch",
          metadata: { label: "Mask this value in listings" }
        }
      }),
    [options, initialContextId]
  )

  const form = usePgForm(fields, {
    validationMode: "onBlur",
    validate: {
      keyShape: (api) => {
        const key = String(api.getValue("key") ?? "")
        if (key !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return { field: "key", message: "Use letters, digits and underscores", code: "BAD_KEY" }
        }
        return null
      }
    },
    onSubmit: (values) => void submit(values as Record<string, unknown>)
  })

  const submit = async (values: Record<string, unknown>): Promise<void> => {
    setSubmitting(true)
    try {
      const saved = await setEnvVar({
        contextId: ContextId.make(String(values["contextId"])),
        key: String(values["key"]),
        value: String(values["value"] ?? ""),
        secret: values["secret"] === true
      })
      if (saved) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      title="Set environment variable"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={submitting} onClick={() => void form.getFormApi().submit()}>
            {submitting ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <GeneratePgForm generateFormProps={form.generateFormProps} components={baseComponents} />
    </Dialog>
  )
}
