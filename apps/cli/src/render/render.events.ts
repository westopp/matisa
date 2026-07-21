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
      `${ev.payload.exposure.url} ${ev.payload.exposure.enabled ? "up" : "down"}`
    ),
    Match.when({ type: "catalog_changed" }, (ev) => ev.payload.action),
    Match.exhaustive
  )
  const ts = new Date(e.ts).toISOString()
  return `#${e.seq} ${ts} ${e.projectId} ${e.type} ${summary}`
}
