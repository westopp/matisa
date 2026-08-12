import type { ExposureEntry, Health, ProjectId, RuntimeState } from "@matisa/core"
import type { NewEvent } from "@matisa/store"

// Typed builders for the engine-event envelopes. `seq` is assigned by the store
// on append; these produce the NewEvent (seq-less) payloads the EventsHub emits.
// Return-type annotations force each shape to match the core event contract.

export const stateChanged = (
  projectId: ProjectId,
  from: RuntimeState,
  to: RuntimeState,
  reason?: string
): NewEvent => ({
  ts: Date.now(),
  projectId,
  type: "state_changed",
  payload: reason !== undefined ? { from, to, reason } : { from, to }
})

export const logLine = (
  projectId: ProjectId,
  stream: "stdout" | "stderr",
  line: string,
  service?: string
): NewEvent => ({
  ts: Date.now(),
  projectId,
  type: "log_line",
  payload: service !== undefined ? { stream, line, service } : { stream, line }
})

export const crashed = (
  projectId: ProjectId,
  exitCode?: number,
  signal?: string,
  reason?: string,
  summary?: string,
  logTail?: string
): NewEvent => ({
  ts: Date.now(),
  projectId,
  type: "crashed",
  payload: {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(logTail !== undefined ? { logTail } : {})
  }
})

export const healthChanged = (
  projectId: ProjectId,
  health: Health,
  message?: string
): NewEvent => ({
  ts: Date.now(),
  projectId,
  type: "health_changed",
  payload: message !== undefined ? { health, message } : { health }
})

export const exposureChanged = (
  projectId: ProjectId,
  entries: ReadonlyArray<ExposureEntry>
): NewEvent => ({
  ts: Date.now(),
  projectId,
  type: "exposure_changed",
  payload: { entries }
})

export const catalogChanged = (
  projectId: ProjectId,
  action: "added" | "updated" | "removed"
): NewEvent => ({
  ts: Date.now(),
  projectId,
  type: "catalog_changed",
  payload: { action }
})
