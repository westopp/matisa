import { useEffect, type ReactNode } from "react"
import { Icons } from "../icons"

// Modal shell. Escape closes, the scrim closes, the body scrolls — nothing else.

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

  return (
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
    </div>
  )
}
