import { toast } from "sonner"
import { notify as nativeNotify } from "./native"
import { router } from "../router"

// ────────────────────────────────────────────────────────────────────────────
// Raising an event to a person.
//
// Two channels, chosen by one fact — whether the window has focus:
//   • focused   → a toast, because you are looking at the app and an OS banner
//                 over the window you are already reading is a second copy.
//   • unfocused → a system notification, because a toast in a window you cannot
//                 see is the same as no notification at all.
//
// This module is deliberately dumb about WHETHER to notify: it is handed things
// already judged worth raising. The preferences live in the settings document
// and the judgement is made at the call site in store.engine, which is the side
// that has both the event and the user's answer about that kind of event.
//
// What it does own is the part that is easy to get wrong twice: not saying the
// same thing over and over. A project in a crash loop emits `crashed` every few
// seconds, and a notifier without a floor turns the first genuinely useful alert
// into a stream the user switches off permanently.
// ────────────────────────────────────────────────────────────────────────────

/** How long the same subject stays quiet after being raised. Long enough to
 *  cover a restart loop, short enough that a crash an hour later is still news. */
const QUIET_MS = 60_000

/** A hard ceiling on how many can be raised in a window, whatever their
 *  subjects. Ten projects failing at once (a docker daemon dying, say) is ONE
 *  thing that happened, and ten banners is not ten times as informative. */
const BURST_LIMIT = 4
const BURST_MS = 10_000

const lastBySubject = new Map<string, number>()
const recent: Array<number> = []

export interface Notifiable {
  /** Dedupe key — the project and what happened to it. Two of these inside
   *  QUIET_MS is the same news twice. */
  readonly subject: string
  readonly title: string
  readonly body?: string
  /** Where to go when the notification is acted on. Omitted when there is
   *  nowhere useful to land. */
  readonly projectId?: string
}

const throttled = (subject: string, now: number): boolean => {
  const last = lastBySubject.get(subject)
  if (last !== undefined && now - last < QUIET_MS) return true

  while (recent.length > 0 && now - (recent[0] ?? 0) > BURST_MS) recent.shift()
  if (recent.length >= BURST_LIMIT) return true

  lastBySubject.set(subject, now)
  recent.push(now)
  return false
}

const open = (projectId: string): void => {
  void router.navigate({ to: "/project/$projectId", params: { projectId } })
}

/** Raise it on whichever channel fits, or drop it if the same thing was just
 *  said. `allowNative` is the user's "escalate when unfocused" preference —
 *  false keeps everything in-app even when the window cannot be seen. */
export const raise = (item: Notifiable, allowNative: boolean): void => {
  if (throttled(item.subject, Date.now())) return

  const focused = document.hasFocus()

  if (!focused && allowNative) {
    void nativeNotify(item.title, item.body).then((delivered) => {
      // The OS refused (permissions, an unsupported platform, a browser tab).
      // The toast is still worth queueing: the window will be read eventually,
      // and silently dropping the event is the one outcome with no recovery.
      if (!delivered) inApp(item)
    })
    return
  }

  inApp(item)
}

const inApp = (item: Notifiable): void => {
  const { projectId } = item
  toast(item.title, {
    ...(item.body === undefined ? {} : { description: item.body }),
    ...(projectId === undefined
      ? {}
      : { action: { label: "Open", onClick: () => open(projectId) } })
  })
}
