import { useEffect, useMemo, useState } from "react"
import { GeneratePgForm, pgf, usePgForm } from "@westopp/pgform"
import type { CommandVar, NamedCommand, ProjectId } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { baseComponents } from "./form.components"
import { Dialog } from "./dialog"

// ────────────────────────────────────────────────────────────────────────────
// Named-command editor. A command carries its own env overrides, injected
// whenever that command runs — they are the command's own, so there is nothing
// to scope them to and no condition under which they do not apply.
// ────────────────────────────────────────────────────────────────────────────

export const SetCommandDialog = ({
  projectId,
  existing,
  onClose
}: {
  projectId: ProjectId
  existing?: NamedCommand
  onClose: () => void
}) => {
  const setCommand = useEngine((s) => s.setCommand)
  const [submitting, setSubmitting] = useState(false)

  const fields = useMemo(
    () =>
      pgf.formData({
        name: {
          type: "text",
          required: { value: true, message: "Required" },
          defaultValue: existing?.name ?? "",
          formatters: { onChange: ["trimmed"] },
          metadata: { label: "Name", placeholder: "test", mono: true }
        },
        command: {
          type: "text",
          required: { value: true, message: "Required" },
          defaultValue: existing?.command ?? "",
          metadata: {
            label: "Command",
            placeholder: "npm run test -- --watch",
            mono: true,
            description: "Run through $SHELL -c on a PTY in the project root."
          }
        },
        vars: {
          type: "group-array",
          metadata: { label: "Environment overrides" },
          fields: {
            key: { type: "text", metadata: { label: "Key", placeholder: "NODE_ENV", mono: true } },
            value: { type: "text", metadata: { label: "Value", placeholder: "test", mono: true } }
          }
        }
      }),
    [existing]
  )

  const form = usePgForm(fields, {
    validationMode: "onBlur",
    onSubmit: (values) => void submit(values as Record<string, unknown>)
  })

  // A group-array has no declarative default — its rows are added, not declared
  // — so an edit has to lay the existing vars in itself. Without this the editor
  // opens empty and saving wipes the vars the command already had.
  //
  // Guarded on the array being empty rather than on a "did this run" flag: the
  // rows live in the form store, not in React state, so StrictMode's second
  // effect pass would otherwise add every var twice.
  useEffect(() => {
    const vars = form.getFieldApi("vars")
    if (vars.getArrayCount() > 0) return
    for (const v of existing?.vars ?? []) vars.addItem({ key: v.key, value: v.value })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (values: Record<string, unknown>): Promise<void> => {
    setSubmitting(true)
    try {
      const rawVars = Array.isArray(values["vars"]) ? (values["vars"] as Array<Record<string, unknown>>) : []
      const vars: ReadonlyArray<CommandVar> = rawVars
        .filter((v) => String(v["key"] ?? "").trim() !== "")
        .map((v) => ({ key: String(v["key"]).trim(), value: String(v["value"] ?? "") }))

      const saved = await setCommand({
        projectId,
        name: String(values["name"]).trim(),
        command: String(values["command"]),
        vars
      })
      if (saved) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      title={existing === undefined ? "New command" : `Edit "${existing.name}"`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={submitting} onClick={() => void form.getFormApi().submit()}>
            {submitting ? "Saving…" : "Save command"}
          </button>
        </>
      }
    >
      <GeneratePgForm generateFormProps={form.generateFormProps} components={baseComponents} />
    </Dialog>
  )
}
