import type { ReactNode } from "react"
import { Dialog } from "./dialog"

// Confirmation for the destructive things — deleting an environment takes its
// variables with it, and nothing here is undoable. Deliberately NOT lazy: a
// confirmation that arrives a frame after the click is a confirmation the user
// has already stopped reading.

export const ConfirmDialog = ({
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel
}: {
  title: string
  children: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) => (
  <Dialog
    title={title}
    onClose={onCancel}
    footer={
      <>
        <button className="btn" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </>
    }
  >
    <div className="confirm-body">{children}</div>
  </Dialog>
)
