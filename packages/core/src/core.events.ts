import { Schema } from "effect"
import { ExposureEntry, Health, ProjectId, RuntimeState } from "./core.schemas.js"

// ────────────────────────────────────────────────────────────────────────────
// EngineEvent — the durable-queue payload contract.
//
// Each event carries { seq, ts } plus a discriminant `type` and a typed
// `payload`. `seq` is the sqlite autoincrement cursor (monotonic, gap-free per
// the events table) — clients pull by it and resume from the last seen value;
// live delivery is via PubSub push. `ts` is epoch milliseconds.
//
// Most events also carry `projectId`, because most things that happen here
// happen TO a project and the id is the subject of the sentence. Configuration
// that belongs to no single project — a group, an env context — has no such
// subject, so those events are built without the field rather than given a
// fabricated one. `unscoped` is that second envelope, and the union being
// discriminated on `type` means a consumer reading `projectId` must first
// narrow to a branch that has it.
// ────────────────────────────────────────────────────────────────────────────

const common = { seq: Schema.Int, ts: Schema.Number }

const envelope = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  payload: Fields
) =>
  Schema.Struct({
    ...common,
    projectId: ProjectId,
    type: Schema.Literal(type),
    payload: Schema.Struct(payload)
  })

const unscoped = <Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  payload: Fields
) =>
  Schema.Struct({
    ...common,
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

/** A project's exposure set changed — carries the FULL current entry list so
 * clients replace rather than merge (an empty list clears the project). */
export const ExposureChangedEvent = envelope("exposure_changed", {
  entries: Schema.Array(ExposureEntry)
})
export type ExposureChangedEvent = typeof ExposureChangedEvent.Type

/** The catalog changed (project added / updated / removed). */
export const CatalogChangedEvent = envelope("catalog_changed", {
  action: Schema.Literal("added", "updated", "removed")
})
export type CatalogChangedEvent = typeof CatalogChangedEvent.Type

/** Configuration that is not a project row changed. `scope` names the slice a
 * client must re-read; `id` identifies the row within it — a group slug, a
 * context id, or the project id whose commands or failures moved. `id` is
 * absent when the change is whole-slice, which is what a clear-all is.
 *
 * This exists because catalog_changed cannot express any of them: it is keyed
 * by projectId and means "that project's row is stale", so widening it would
 * have made every consumer re-read a project to learn a group was renamed. */
export const ConfigChangedEvent = unscoped("config_changed", {
  scope: Schema.Literal("group", "context", "commands", "failures", "settings"),
  action: Schema.Literal("added", "updated", "removed"),
  id: Schema.optional(Schema.String)
})
export type ConfigChangedEvent = typeof ConfigChangedEvent.Type

export const EngineEvent = Schema.Union(
  StateChangedEvent,
  LogLineEvent,
  CrashedEvent,
  HealthChangedEvent,
  ExposureChangedEvent,
  CatalogChangedEvent,
  ConfigChangedEvent
)
export type EngineEvent = typeof EngineEvent.Type

/** The discriminant string set, for exhaustive matching by consumers. */
export const EventType = Schema.Literal(
  "state_changed",
  "log_line",
  "crashed",
  "health_changed",
  "exposure_changed",
  "catalog_changed",
  "config_changed"
)
export type EventType = typeof EventType.Type
