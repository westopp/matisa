import { Schema } from "effect"
import { Exposure, Health, ProjectId, RuntimeState } from "./core.schemas.js"

// ────────────────────────────────────────────────────────────────────────────
// EngineEvent — the durable-queue payload contract.
//
// Each event carries the common envelope fields { seq, ts, projectId } plus a
// discriminant `type` and a typed `payload`. `seq` is the sqlite autoincrement
// cursor (monotonic, gap-free per the events table) — clients pull by it and
// resume from the last seen value; live delivery is via PubSub push. `ts` is
// epoch milliseconds.
//
// The whole event is a discriminated union on `type`, so decoding an unknown
// frame yields a fully-typed payload.
// ────────────────────────────────────────────────────────────────────────────

const envelope = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  payload: Fields
) =>
  Schema.Struct({
    seq: Schema.Int,
    ts: Schema.Number,
    projectId: ProjectId,
    type: Schema.Literal(type),
    payload: Schema.Struct(payload)
  })

/** FSM transitioned between runtime states. */
export const StateChangedEvent = envelope("state_changed", {
  from: RuntimeState,
  to: RuntimeState,
  reason: Schema.optional(Schema.String)
})
export type StateChangedEvent = typeof StateChangedEvent.Type

/** A line of child-process output. `service` is set only for compose stacks,
 * where one stream carries every service's output — the engine parses the
 * `<service>-<n> |` prefix off each line so clients can filter without
 * re-implementing compose's log format. */
export const LogLineEvent = envelope("log_line", {
  stream: Schema.Literal("stdout", "stderr"),
  line: Schema.String,
  service: Schema.optional(Schema.String)
})
export type LogLineEvent = typeof LogLineEvent.Type

/** Supervised child exited non-zero (real reaped exit, not a poll). Carries a
 * human summary + the last lines of output so clients can surface WHY. */
export const CrashedEvent = envelope("crashed", {
  exitCode: Schema.optional(Schema.Int),
  signal: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  logTail: Schema.optional(Schema.String)
})
export type CrashedEvent = typeof CrashedEvent.Type

/** Observed readiness changed (waiting → ready | timeout). Orthogonal to
 * state_changed — `running + timeout` means alive but never bound its port. */
export const HealthChangedEvent = envelope("health_changed", {
  health: Health,
  message: Schema.optional(Schema.String)
})
export type HealthChangedEvent = typeof HealthChangedEvent.Type

/** A project's reverse-proxy exposure came up / changed / went down. */
export const ExposureChangedEvent = envelope("exposure_changed", {
  exposure: Exposure
})
export type ExposureChangedEvent = typeof ExposureChangedEvent.Type

/** The catalog changed (project added / updated / removed). */
export const CatalogChangedEvent = envelope("catalog_changed", {
  action: Schema.Literal("added", "updated", "removed")
})
export type CatalogChangedEvent = typeof CatalogChangedEvent.Type

export const EngineEvent = Schema.Union(
  StateChangedEvent,
  LogLineEvent,
  CrashedEvent,
  HealthChangedEvent,
  ExposureChangedEvent,
  CatalogChangedEvent
)
export type EngineEvent = typeof EngineEvent.Type

/** The discriminant string set, for exhaustive matching by consumers. */
export const EventType = Schema.Literal(
  "state_changed",
  "log_line",
  "crashed",
  "health_changed",
  "exposure_changed",
  "catalog_changed"
)
export type EventType = typeof EventType.Type
