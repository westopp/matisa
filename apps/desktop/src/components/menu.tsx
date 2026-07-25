import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

// ────────────────────────────────────────────────────────────────────────────
// A small anchored menu — the popup behind the card's ••• and its environment
// chip. Not a dialog: no scrim, no focus trap. It closes when you say so —
// Escape, or a click outside it — and NOT for anything else.
//
// Portalled to <body> and positioned FIXED for one reason: the sidebar is a
// scroll container with its own stacking context, so a menu rendered in place
// would be clipped by the very row it belongs to.
//
// Because the position is fixed, it has to be recomputed whenever the trigger
// moves. This tracks the trigger ELEMENT rather than a rect snapshot and
// re-places itself on scroll — an earlier version closed on scroll instead,
// which meant a terminal streaming log lines shut the menu every couple of
// seconds and made it look like it was on a timer.
// ────────────────────────────────────────────────────────────────────────────

export interface MenuItem {
  readonly key: string
  readonly label: string
  /** Dim word before the label — the VERB this row performs ("start", "stop"),
   *  so the row reads as an action rather than as a list entry you must guess
   *  the effect of. */
  readonly verb?: string
  readonly icon?: ReactNode
  /** Rendered right-aligned and dim — a count, a shortcut, a hint. */
  readonly note?: string
  readonly danger?: boolean
  readonly disabled?: boolean
  /** Shows the check column. The column is reserved for the whole menu as soon
   *  as ONE item is selectable, so picking a different item never shifts the
   *  labels sideways. */
  readonly selected?: boolean
  /** Status light in the same leading column as the check: green up, amber
   *  mid-transition, red down. */
  readonly dot?: "success" | "warning" | "danger" | "muted"
  /** A second, independent control at the end of the row. It is NOT the row's
   *  action — clicking it never triggers `onSelect`. */
  readonly action?: {
    readonly icon: ReactNode
    readonly title: string
    readonly disabled?: boolean
    readonly onClick: () => void
  }
  readonly onSelect: () => void
}

const MARGIN = 8

export const Menu = ({
  trigger,
  items,
  onClose
}: {
  /** The element the menu hangs from. Held live, not as a rect, so a scroll
   *  moves the menu with it instead of stranding it. */
  trigger: HTMLElement
  items: ReadonlyArray<MenuItem>
  onClose: () => void
}) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Callers pass a fresh `onClose` closure every render. Held in a ref so it
  // never becomes a dependency: as a dep it would re-create `place`, re-run the
  // layout effect, set a new position object, and render again — forever.
  const close = useRef(onClose)
  close.current = onClose

  const place = useCallback((): void => {
    const el = ref.current
    if (el === null) return
    const a = trigger.getBoundingClientRect()
    const { width, height } = el.getBoundingClientRect()

    // Scrolled clean out of sight: there is nothing left to hang from, so the
    // menu would float over unrelated content. That is the one case where
    // closing is the honest answer — and it is gated on the viewport having a
    // height at all, because a window reporting 0 (hidden, collapsed, mid-
    // layout) makes EVERY element read as off-screen and would slam the menu
    // shut the instant it opened.
    const viewport = window.innerHeight
    if (viewport > 0 && (a.bottom < 0 || a.top > viewport)) {
      close.current()
      return
    }

    const left = Math.min(a.left, window.innerWidth - width - MARGIN)
    // Flip above the trigger when there is no room below — but only if above is
    // genuinely roomier, so a menu taller than the viewport still opens
    // downward instead of running off the top.
    const below = a.bottom + 4
    const above = a.top - 4 - height
    const top = below + height > window.innerHeight - MARGIN && above > MARGIN ? above : below
    const next = {
      left: Math.max(MARGIN, left),
      top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN))
    }
    // Same coordinates → same object, so a scroll that does not move the
    // trigger (a terminal streaming below it) costs nothing and re-renders
    // nothing.
    setPos((prev) => (prev !== null && prev.left === next.left && prev.top === next.top ? prev : next))
  }, [trigger])

  // Measure before paint, so the menu is never seen at the unplaced position.
  useLayoutEffect(place, [place])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close.current()
    }
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      // The trigger is not "outside": it owns the toggle, and closing here
      // would race its own click handler into reopening the menu immediately.
      if (ref.current?.contains(target) === true || trigger.contains(target)) return
      close.current()
    }

    // Scroll fires per frame from any scroller in the app (terminals stream
    // constantly), so the re-place is coalesced onto one frame.
    let frame = 0
    const onMove = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        place()
      })
    }

    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("scroll", onMove, true)
    window.addEventListener("resize", onMove)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("scroll", onMove, true)
      window.removeEventListener("resize", onMove)
    }
  }, [place, trigger])

  // One leading column, reserved for the whole menu as soon as ONE item wants
  // it — a check or a status light, never both — so rows stay aligned however
  // their states differ.
  const showLead = items.some((i) => i.selected !== undefined || i.dot !== undefined)

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      // A portal escapes the DOM but not the React tree, so without this a
      // click in the menu still bubbles to whatever row opened it.
      onClick={(e) => e.stopPropagation()}
      // Hidden rather than absent until placed: it has to be in the document to
      // have a size, and `visibility` keeps it out of sight while it gets one.
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos === null ? "hidden" : "visible"
      }}
    >
      {items.map((item) => (
        // A row, not a button: an item may carry its own trailing control, and
        // a button inside a button is not a thing the DOM will honour.
        <div key={item.key} className="menu-row">
          <button
            className={`menu-item ${item.danger === true ? "danger" : ""} ${item.selected === true ? "selected" : ""}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {showLead &&
              (item.dot !== undefined ? (
                <span className={`menu-dot ${item.dot}`} />
              ) : (
                <span className="menu-check">{item.selected === true ? "●" : ""}</span>
              ))}
            {item.icon !== undefined && <span className="menu-ico">{item.icon}</span>}
            {item.verb !== undefined && <span className="menu-verb">{item.verb}</span>}
            <span className="menu-label">{item.label}</span>
            {item.note !== undefined && <span className="menu-note">{item.note}</span>}
          </button>
          {item.action !== undefined && (
            <button
              className="menu-action"
              title={item.action.title}
              aria-label={item.action.title}
              disabled={item.action.disabled}
              onClick={() => {
                onClose()
                item.action?.onClick()
              }}
            >
              {item.action.icon}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body
  )
}
