import { useEffect, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Icons } from "../icons"

// Modal shell. Escape closes, the scrim closes, the body scrolls — nothing else.
//
// PORTALLED TO document.body, and it has to be. A dialog is rendered wherever
// the thing it edits lives — the project row renders its own edit dialog, deep
// inside `.fleet` — and `.fleet` and `.pane-wrap` both carry a
// `view-transition-name`. An element with one forms a stacking context AND a
// containing block for fixed descendants, so a `position: fixed` scrim inside
// either is boxed into that pane and painted with it. `.drawer` is a positioned
// sibling of those panes at z-index 40, so it wins against the whole fleet
// subtree no matter what the scrim's own z-index says — the edit dialog opened
// UNDER the inspector, and raising z-index 60 higher could never have fixed it.
//
// The portal takes the scrim out of every ancestor's stacking context and
// containing block at once, which is the only fix that stays fixed: the next
// pane to get a `view-transition-name`, a `contain`, or a `filter` would
// otherwise reintroduce this, and the symptom (a modal behind a panel) points
// nowhere near the cause.
//
// Events still reach React parents: a portal breaks DOM containment, not the
// React tree, so the row's click-catching wrapper around this still stops a
// dialog click from selecting the project underneath it.

export const Dialog = ({
  title,
  onClose,
  children,
  footer
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title}>
        <header className="dialog-head">
          <span className="dialog-title">{title}</span>
          <span style={{ flex: 1 }} />
          <button className="ico" onClick={onClose} title="Close">
            <Icons.X size={14} />
          </button>
        </header>
        <div className="dialog-body scroll">{children}</div>
        {footer !== undefined && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
