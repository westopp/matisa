import { useEffect, useRef } from "react"
import type {
  BasePgFormFieldComponents,
  PgFormArrayComponentProps,
  PgFormMetadata,
  PgFormNumberFieldProps,
  PgFormSelectGroupFieldProps,
  PgFormTextFieldProps,
  PgFormToggleGroupFieldProps
} from "@westopp/pgform"
import {
  checkDirectoryExists,
  checkImageReadable,
  chooseDirectory,
  chooseImageFile
} from "~/store/store.picker"
import { Icons } from "../icons"

// ────────────────────────────────────────────────────────────────────────────
// The BYOC component map. pgform owns state, validation and formatting; this
// module owns nothing but presentation, so every form in the app renders with
// identical chrome and identical error placement.
//
// The metadata conventions used across the app's forms:
//   multiline: true  → render a textarea
//   mono: true       → monospace input (paths, commands, env values)
//   browse: true     → folder path: picker button + existence check
//   pickFile: true   → file path: picker button + readable-image check
//   readOnly: true   → shown, not editable (a field that is fixed after create)
// ────────────────────────────────────────────────────────────────────────────

const FieldLabel = ({ metadata, required }: { metadata: PgFormMetadata; required: boolean }) =>
  metadata.label === undefined ? null : (
    <span className="field-label">
      {metadata.label}
      {required && <span className="req">*</span>}
    </span>
  )

const FieldFoot = ({
  error,
  description,
  loading
}: {
  error?: string
  description?: unknown
  loading?: boolean
}) =>
  loading === true ? (
    <span className="field-hint">Checking…</span>
  ) : error !== undefined ? (
    <span className="field-error">{error}</span>
  ) : typeof description === "string" ? (
    <span className="field-hint">{description}</span>
  ) : null

const TextField = (props: PgFormTextFieldProps) => {
  const error = props.fieldApi.firstError
  const multiline = props.metadata["multiline"] === true
  const mono = props.metadata["mono"] === true
  const browse = props.metadata["browse"] === true
  const pickFile = props.metadata["pickFile"] === true
  const isPath = browse || pickFile
  const cls = `${multiline ? "field-textarea" : "field-input"}${mono ? " mono" : ""}${error === undefined ? "" : " invalid"}`

  // Path fields are real filesystem paths, whether picked or typed by hand —
  // verify them instead of trusting free text the engine would only reject
  // later, deep into a save round trip.
  const checkedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isPath) return
    const value = typeof props.value === "string" ? props.value.trim() : ""
    if (value === "" || value === checkedRef.current) return

    const timer = setTimeout(() => {
      props.fieldApi.clearErrors()
      props.fieldApi.setLoading(true)
      void (browse ? checkDirectoryExists(value) : checkImageReadable(value)).then((result) => {
        checkedRef.current = value
        props.fieldApi.setLoading(false)
        if (!result.ok) props.fieldApi.addError({ message: result.message, code: "NOT_FOUND" })
      })
    }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPath, browse, props.value])

  const input = (
    <input
      type="text"
      spellCheck={false}
      autoComplete="off"
      className={cls}
      value={props.value ?? ""}
      placeholder={props.metadata.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onBlur}
      onFocus={props.onFocus}
    />
  )

  const pick = (): void => {
    const current = typeof props.value === "string" && props.value !== "" ? props.value : undefined
    void (browse ? chooseDirectory(current) : chooseImageFile(current)).then((picked) => {
      // Null means the panel was dismissed — keep what was typed.
      if (picked !== null) props.onChange(picked)
    })
  }

  return (
    <div className="field">
      <FieldLabel metadata={props.metadata} required={props.fieldApi.isRequired} />
      {multiline ? (
        <textarea
          className={cls}
          value={props.value ?? ""}
          placeholder={props.metadata.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={props.onBlur}
          onFocus={props.onFocus}
        />
      ) : isPath ? (
        <div className="field-row">
          {input}
          <button type="button" className="ico" title="Browse…" onClick={pick}>
            {browse ? <Icons.Folder size={14} /> : <Icons.Image size={14} />}
          </button>
        </div>
      ) : (
        input
      )}
      <FieldFoot error={error} description={props.metadata.description} loading={isPath && props.fieldApi.isLoading} />
    </div>
  )
}

const NumberField = (props: PgFormNumberFieldProps) => {
  const error = props.fieldApi.firstError
  return (
    <div className="field" data-field={props.fieldKey}>
      <FieldLabel metadata={props.metadata} required={props.fieldApi.isRequired} />
      <input
        type="number"
        className={`field-input mono${error === undefined ? "" : " invalid"}`}
        value={Number.isFinite(props.value) ? props.value : ""}
        placeholder={props.metadata.placeholder}
        min={props.config["min"] as number | undefined}
        max={props.config["max"] as number | undefined}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onBlur={props.onBlur}
        onFocus={props.onFocus}
      />
      <FieldFoot error={error} description={props.metadata.description} />
    </div>
  )
}

// The `selectFields` / `toggleFields` slots are catch-alls: their value type is
// the union across every member (single AND multi). Only single-select and
// boolean fields are used in this app, so each narrows on the way in.

const SelectField = (props: PgFormSelectGroupFieldProps) => {
  const error = props.fieldApi.firstError
  return (
    <div className="field">
      <FieldLabel metadata={props.metadata} required={props.fieldApi.isRequired} />
      <select
        className={`field-select${error === undefined ? "" : " invalid"}`}
        value={typeof props.value === "string" ? props.value : ""}
        disabled={props.metadata["readOnly"] === true}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onBlur}
        onFocus={props.onFocus}
      >
        <option value="">{props.metadata.placeholder ?? "Select…"}</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label ?? o.value}
          </option>
        ))}
      </select>
      <FieldFoot error={error} description={props.metadata.description} />
    </div>
  )
}

const ToggleField = (props: PgFormToggleGroupFieldProps) => (
  <div className="field">
    <label className="toggle">
      <input type="checkbox" checked={props.value === true} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{props.metadata.label}</span>
    </label>
    <FieldFoot error={props.fieldApi.firstError} description={props.metadata.description} />
  </div>
)

// —— arrays ——
//
// The remove control lives on the CONTAINER, not on item components. pgform
// resolves a group-array item's component by its positional key (`vars[0]`),
// which is not a stable slot name, so a group-array item can never register its
// own wrapper. Rendering the row here is the one place that works for both
// scalar arrays (`ports`) and group arrays (`vars`).

const ArrayContainer = (props: PgFormArrayComponentProps) => {
  // Scalar field slots get hidden for free from GeneratePgForm; the array
  // container renders its own wrapper, so it must honor `hidden` itself.
  return (
  <div className="field" data-field={props.fieldKey}>
    {props.metadata.label !== undefined && <span className="field-label">{props.metadata.label}</span>}
    <div className="arr">
      {props.items.map((item) => (
        <div className="arr-item" key={item.key}>
          <div className="field-row" style={{ flex: 1, minWidth: 0 }}>
            {item.element}
          </div>
          <button
            type="button"
            className="ico danger-hover"
            onClick={() => props.removeItem(item.key)}
            disabled={!props.canRemove}
            title="Remove"
          >
            <Icons.Trash size={13} />
          </button>
        </div>
      ))}
      {props.items.length === 0 && <span className="field-hint">None yet.</span>}
      <button type="button" className="btn sm arr-add" onClick={() => props.addItem()} disabled={!props.canAdd}>
        <Icons.Plus size={12} /> Add
      </button>
    </div>
    {props.fieldApi.firstError !== undefined && <span className="field-error">{props.fieldApi.firstError}</span>}
  </div>
  )
}

export const baseComponents: BasePgFormFieldComponents = {
  textFields: TextField,
  numberFields: NumberField,
  selectFields: SelectField,
  toggleFields: ToggleField,
  array: ArrayContainer
}
