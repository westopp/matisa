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

/** A docker/compose action needs the Docker daemon and it is not running.
 * The engine NEVER auto-starts Docker — clients catch this, prompt the user,
 * call docker.daemon.start on consent, then replay the original action. */
export class DockerDaemonRequired extends Schema.TaggedError<DockerDaemonRequired>()(
  "DockerDaemonRequired",
  {
    code: stableCode("E_DOCKER_DAEMON_REQUIRED"),
    action: Schema.String,
    projectId: Schema.optional(ProjectId),
    message: Schema.String
  }
) {}

/** A project's declared port is already bound by a process the engine does
 * not manage — surfaced BEFORE spawn so the user always knows who owns it. */
export class PortBusy extends Schema.TaggedError<PortBusy>()("PortBusy", {
  code: stableCode("E_PORT_BUSY"),
  port: Schema.Int,
  /** Pid of the foreign listener when identifiable (lsof). */
  pid: Schema.optional(Schema.Int),
  processName: Schema.optional(Schema.String),
  message: Schema.String
}) {}

/** Union of every error that may cross the wire. */
export const EngineError = Schema.Union(
  NotFound,
  PortConflict,
  ValidationError,
  EngineInternal,
  DockerDaemonRequired,
  PortBusy
)
export type EngineError = typeof EngineError.Type
