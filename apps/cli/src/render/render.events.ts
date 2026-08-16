import { Match } from "effect"
import type { EngineEvent } from "@matisa/core"

// Stable one-line rendering of an EngineEvent, shared by `watch` and `events`:
//   <seq> <iso-ts> <projectId> <type> <payload-summary>
export const formatEvent = (e: EngineEvent): string => {
  const summary = Match.value(e).pipe(
    Match.when({ type: "state_changed" }, (ev) =>
      `${ev.payload.from} -> ${ev.payload.to}${
        ev.payload.reason === undefined ? "" : ` (${ev.payload.reason})`
      }`
    ),
    Match.when({ type: "log_line" }, (ev) => `${ev.payload.stream}: ${ev.payload.line}`),
    Match.when({ type: "crashed" }, (ev) =>
      `exit=${ev.payload.exitCode ?? "?"}${
        ev.payload.signal === undefined ? "" : ` signal=${ev.payload.signal}`
      }${ev.payload.summary === undefined ? "" : ` — ${ev.payload.summary}`}`
    ),
    Match.when({ type: "health_changed" }, (ev) =>
      `${ev.payload.health}${ev.payload.message === undefined ? "" : ` (${ev.payload.message})`}`
    ),
    Match.when({ type: "exposure_changed" }, (ev) =>
      ev.payload.entries.length === 0
        ? "cleared"
        : ev.payload.entries.map((x) => `${x.url} ${x.enabled ? x.state : "off"}`).join(", ")
    ),
    Match.when({ type: "catalog_changed" }, (ev) => ev.payload.action),
    Match.when({ type: "config_changed" }, (ev) =>
      `${ev.payload.scope} ${ev.payload.action}${ev.payload.id === undefined ? "" : ` ${ev.payload.id}`}`
    ),
    Match.exhaustive
  )
  const ts = new Date(e.ts).toISOString()
  // config_changed names no project. The column is held with a dash rather than
  // dropped so the line stays fixed-arity for anything cutting it by field.
  const subject = e.type === "config_changed" ? "-" : e.projectId
  return `#${e.seq} ${ts} ${subject} ${e.type} ${summary}`
}
