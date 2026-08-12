import { flushSync } from "react-dom"

// ────────────────────────────────────────────────────────────────────────────
// View transitions for the three-pane shell.
//
// The board and the rail are the SAME cards at two widths, so the motion
// between them is a morph, not a crossfade: every card is tagged with a stable
// `view-transition-name`, and the browser tweens each one from where it sat in
// the grid to where it lands in the column. Animating that by hand would mean
// measuring every card before and after and playing the delta back — which is
// exactly what this API does, correctly, for free.
//
// Route-driven flips (opening or closing a project) do not come through
// `withTransition`: a navigation lands asynchronously, so only the router can
// wrap its own commit. It takes `viewTransition: true` for that.
// ────────────────────────────────────────────────────────────────────────────

interface ViewTransition {
  readonly ready: Promise<void>
  readonly finished: Promise<void>
}

type WithVT = Document & { startViewTransition?: (cb: () => void) => ViewTransition }

const doc = document as WithVT
const native = doc.startViewTransition?.bind(doc)

if (native === undefined) {
  // The fallback path animates with CSS instead, and the two must never both
  // run: a flex-basis transition still travelling underneath a snapshot overlay
  // jumps when the overlay lifts. This class is what turns those on.
  document.documentElement.classList.add("no-vt")
} else {
  // `ready` rejects whenever the browser DECLINES to animate — a backgrounded
  // tab, a second navigation landing on top of the first. The DOM still
  // updates; only the tween is dropped, so none of that is an error here. The
  // router starts its own transitions and does not handle it, which surfaces as
  // a red console entry on ordinary navigations. Absorbed once, at the source,
  // so every caller is covered — ours and the router's alike.
  doc.startViewTransition = (cb) => {
    const t = native(cb)
    void t.ready.catch(() => {})
    return t
  }
}

/** Flip layout state inside a view transition. `flushSync` is not optional:
 *  without it React commits after the browser has already taken its "after"
 *  snapshot, and the transition captures no change at all. */
export const withTransition = (flip: () => void): void => {
  if (doc.startViewTransition === undefined) {
    flip()
    return
  }
  doc.startViewTransition(() => flushSync(flip))
}

/** A card's transition name. Project ids carry path separators and dots, none
 *  of which are legal in a custom-ident, so they are folded to underscores —
 *  the mapping only has to be stable and collision-free within one render. */
export const cardName = (id: string): string => `card-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`
