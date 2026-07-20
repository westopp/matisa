import type { ProjectId, RuntimeState } from "@matisa/core"
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
  line: string
): NewEvent => ({
  ts: Date.now(),
  projectId,
  type: "log_line",
  payload: { stream, line }
})

export const crashed = (
  projectId: ProjectId,
  exitCode?: number,
  signal?: string,
  reason?: string
): NewEvent => ({
  ts: Date.now(),
  projectId,
  type: "crashed",
  payload: {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(reason !== undefined ? { reason } : {})
  }
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
