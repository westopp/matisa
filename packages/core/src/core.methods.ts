import { Schema } from "effect"
import { EngineEvent } from "./core.events.js"
import {
  ContextId,
  EnvContext,
  NewProject,
  Project,
  ProjectId,
  ProjectPatch,
  ProjectWithState,
  RuntimeState,
  SessionId
} from "./core.schemas.js"

// ────────────────────────────────────────────────────────────────────────────
// Per-method param/result schemas.
// Small, named shapes referenced by the registry below. Exported so callers can
// build values against the exact contract.
// ────────────────────────────────────────────────────────────────────────────

export const ById = Schema.Struct({ id: ProjectId })
export type ById = typeof ById.Type

export const BySessionId = Schema.Struct({ sessionId: SessionId })
export type BySessionId = typeof BySessionId.Type

// —— catalog ——

export const CatalogUpdateParams = Schema.Struct({
  id: ProjectId,
  patch: ProjectPatch
})
export type CatalogUpdateParams = typeof CatalogUpdateParams.Type

// —— env ——

export const EnvSetParams = Schema.Struct({
  contextId: ContextId,
  key: Schema.String,
  value: Schema.String,
  /** When true the engine stashes `value` in the keychain and persists only a
   *  secret_ref; plaintext is never written to the DB. */
  secret: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
export type EnvSetParams = typeof EnvSetParams.Type

export const EnvUseParams = Schema.Struct({
  projectId: ProjectId,
  contextId: ContextId
})
export type EnvUseParams = typeof EnvUseParams.Type

// —— lifecycle ——

/** Ack that a lifecycle transition was accepted; final state arrives via events. */
export const Accepted = Schema.Struct({
  id: ProjectId,
  state: RuntimeState
})
export type Accepted = typeof Accepted.Type

export const RuntimeStatus = Schema.Struct({
  id: ProjectId,
  state: RuntimeState,
  pid: Schema.optional(Schema.Int),
  since: Schema.optional(Schema.Number),
  /** The run's PTY session (`run:<projectId>`) — attach/input/resize target. */
  sessionId: Schema.optional(SessionId)
})
export type RuntimeStatus = typeof RuntimeStatus.Type

// —— events ——

export const SubscribeParams = Schema.Struct({
  /** Omit to subscribe to every project's stream. */
  projectId: Schema.optional(ProjectId)
})
export type SubscribeParams = typeof SubscribeParams.Type

export const SubscribeResult = Schema.Struct({
  subscriptionId: Schema.String,
  /** Latest cursor at subscription time; pull anything older by seq. */
  cursor: Schema.Int
})
export type SubscribeResult = typeof SubscribeResult.Type

export const PullParams = Schema.Struct({
  /** Return events with seq strictly greater than this cursor. */
  since: Schema.Int,
  limit: Schema.optionalWith(Schema.Int, { default: () => 100 }),
  projectId: Schema.optional(ProjectId)
})
export type PullParams = typeof PullParams.Type

export const PullResult = Schema.Struct({
  events: Schema.Array(EngineEvent),
  /** Cursor to pass as `since` on the next pull. */
  nextCursor: Schema.Int
})
export type PullResult = typeof PullResult.Type

// —— pty ——

export const PtyOpenParams = Schema.Struct({
  projectId: ProjectId,
  /** Override the shell/command; defaults to the project's start command. */
  command: Schema.optional(Schema.String),
  cols: Schema.optionalWith(Schema.Int, { default: () => 80 }),
  rows: Schema.optionalWith(Schema.Int, { default: () => 24 })
})
export type PtyOpenParams = typeof PtyOpenParams.Type

export const PtySession = Schema.Struct({
  sessionId: SessionId,
  projectId: ProjectId,
  cols: Schema.Int,
  rows: Schema.Int
})
export type PtySession = typeof PtySession.Type

export const Attached = Schema.Struct({
  sessionId: SessionId,
  cols: Schema.Int,
  rows: Schema.Int
})
export type Attached = typeof Attached.Type

export const PtyInputParams = Schema.Struct({
  sessionId: SessionId,
  data: Schema.String
})
export type PtyInputParams = typeof PtyInputParams.Type

export const PtyResizeParams = Schema.Struct({
  sessionId: SessionId,
  cols: Schema.Int,
  rows: Schema.Int
})
export type PtyResizeParams = typeof PtyResizeParams.Type

// ────────────────────────────────────────────────────────────────────────────
// The method registry — the single source of truth for the RPC surface.
//
// The engine dispatcher does `Schema.decodeUnknown(methods[m].params)` inbound
// and `Schema.encode(methods[m].result)` outbound. Clients derive a typed
// `call<M>(m, params)` whose argument and return infer from the same object.
// Rename a method or change a field and every caller fails to compile.
// ────────────────────────────────────────────────────────────────────────────

export const methods = {
  "catalog.add": { params: NewProject, result: Project },
  "catalog.list": { params: Schema.Void, result: Schema.Array(ProjectWithState) },
  "catalog.update": { params: CatalogUpdateParams, result: Project },
  "catalog.remove": { params: ById, result: Schema.Void },

  "env.set": { params: EnvSetParams, result: EnvContext },
  "env.list": { params: Schema.Void, result: Schema.Array(EnvContext) },
  "env.use": { params: EnvUseParams, result: ProjectWithState },

  "lifecycle.start": { params: ById, result: Accepted },
  "lifecycle.stop": { params: ById, result: Accepted },
  "lifecycle.restart": { params: ById, result: Accepted },
  "lifecycle.status": { params: ById, result: RuntimeStatus },

  "events.subscribe": { params: SubscribeParams, result: SubscribeResult },
  "events.pull": { params: PullParams, result: PullResult },

  "pty.open": { params: PtyOpenParams, result: PtySession },
  "pty.attach": { params: BySessionId, result: Attached },
  "pty.input": { params: PtyInputParams, result: Schema.Void },
  "pty.resize": { params: PtyResizeParams, result: Schema.Void }
} as const satisfies Record<string, { params: Schema.Schema.Any; result: Schema.Schema.Any }>

export type Methods = typeof methods
export type Method = keyof Methods

/** Decoded param type for a method. */
export type Params<M extends Method> = Methods[M]["params"]["Type"]
/** Decoded result type for a method. */
export type Result<M extends Method> = Methods[M]["result"]["Type"]

/** Runtime list of every registered method name. */
export const methodNames = Object.keys(methods) as ReadonlyArray<Method>
