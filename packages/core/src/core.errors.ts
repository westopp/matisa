import { Schema } from "effect"
import { ProjectId } from "./core.schemas.js"

// ────────────────────────────────────────────────────────────────────────────
// Wire errors.
//
// Schema.TaggedError subclasses so the engine and every client encode/decode
// them identically. Each carries a stable, machine-readable `code` (defaulted
// at construction — callers never pass it) alongside a human `message`. These
// are the ONLY error shapes allowed to cross the socket; internal engine
// failures are mapped into `EngineInternal` at the boundary.
// ────────────────────────────────────────────────────────────────────────────

const stableCode = <const C extends string>(code: C) =>
  Schema.Literal(code).pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => code)
  )

/** A referenced entity (project, context, session, …) does not exist. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  code: stableCode("E_NOT_FOUND"),
  entity: Schema.String,
  id: Schema.String,
  message: Schema.String
}) {}

/** A requested port is already claimed by another project. */
export class PortConflict extends Schema.TaggedError<PortConflict>()("PortConflict", {
  code: stableCode("E_PORT_CONFLICT"),
  port: Schema.Int,
  heldBy: Schema.optional(ProjectId),
  message: Schema.String
}) {}

/** Inbound params (or a domain invariant) failed validation. */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  code: stableCode("E_VALIDATION"),
  field: Schema.optional(Schema.String),
  issues: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  message: Schema.String
}) {}

/** Catch-all for unexpected engine-side failures mapped at the boundary. */
export class EngineInternal extends Schema.TaggedError<EngineInternal>()("EngineInternal", {
  code: stableCode("E_INTERNAL"),
  cause: Schema.optional(Schema.String),
  message: Schema.String
}) {}

/** Union of every error that may cross the wire. */
export const EngineError = Schema.Union(
  NotFound,
  PortConflict,
  ValidationError,
  EngineInternal
)
export type EngineError = typeof EngineError.Type
