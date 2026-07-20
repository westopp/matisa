import { Schema } from "effect"

// ────────────────────────────────────────────────────────────────────────────
// Branded identifiers
// Opaque string ids so a ProjectId is never accidentally passed where a
// SessionId is expected. Construct with `ProjectId.make("…")` or by decoding.
// ────────────────────────────────────────────────────────────────────────────

export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
export type ProjectId = typeof ProjectId.Type

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const ContextId = Schema.String.pipe(Schema.brand("ContextId"))
export type ContextId = typeof ContextId.Type

// ────────────────────────────────────────────────────────────────────────────
// Runtime FSM states
// The states the supervisor FSM can report. `unmanaged` = discovered/known but
// not supervised by matisa; `errored` = the engine failed to manage it (as
// opposed to `crashed`, which is the child process exiting non-zero).
// ────────────────────────────────────────────────────────────────────────────

export const RuntimeState = Schema.Literal(
  "idle",
  "starting",
  "running",
  "stopping",
  "crashed",
  "errored",
  "unmanaged"
)
export type RuntimeState = typeof RuntimeState.Type

// ────────────────────────────────────────────────────────────────────────────
// Port
// ────────────────────────────────────────────────────────────────────────────

export const PortProtocol = Schema.Literal("tcp", "udp")
export type PortProtocol = typeof PortProtocol.Type

export const Port = Schema.Struct({
  number: Schema.Int.pipe(Schema.between(1, 65535)),
  protocol: Schema.optionalWith(PortProtocol, { default: () => "tcp" as const }),
  description: Schema.optional(Schema.String)
})
export type Port = typeof Port.Type

// ────────────────────────────────────────────────────────────────────────────
// Environment variables & contexts
// A var is either `plain` (value inlined) or `secret` (only a keychain
// reference crosses the wire / lands in the DB — never plaintext).
// ────────────────────────────────────────────────────────────────────────────

export const PlainEnvVar = Schema.Struct({
  kind: Schema.Literal("plain"),
  key: Schema.String,
  value: Schema.String
})
export type PlainEnvVar = typeof PlainEnvVar.Type

export const SecretEnvVar = Schema.Struct({
  kind: Schema.Literal("secret"),
  key: Schema.String,
  // Opaque handle resolved by the keychain provider at spawn time. The plaintext
  // secret is NEVER stored here or in the DB.
  secretRef: Schema.String
})
export type SecretEnvVar = typeof SecretEnvVar.Type

export const EnvVar = Schema.Union(PlainEnvVar, SecretEnvVar)
export type EnvVar = typeof EnvVar.Type

/** A named, reusable set of environment variables (e.g. "dev", "staging"). */
export const EnvContext = Schema.Struct({
  id: ContextId,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  vars: Schema.Array(EnvVar)
})
export type EnvContext = typeof EnvContext.Type

// ────────────────────────────────────────────────────────────────────────────
// Command
// A launchable command line for a project (start/build/etc).
// ────────────────────────────────────────────────────────────────────────────

export const Command = Schema.Struct({
  name: Schema.String,
  program: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String)
})
export type Command = typeof Command.Type

// ────────────────────────────────────────────────────────────────────────────
// Exposure
// How a running project's port is reachable — the reverse-proxy binding.
// ────────────────────────────────────────────────────────────────────────────

export const Exposure = Schema.Struct({
  host: Schema.String,
  port: Schema.Int,
  url: Schema.String,
  enabled: Schema.Boolean
})
export type Exposure = typeof Exposure.Type

// ────────────────────────────────────────────────────────────────────────────
// Project
// The persisted catalog entry. `Project` is the stored shape; `ProjectWithState`
// layers the live FSM-observed runtime state + pid on top for read models.
// ────────────────────────────────────────────────────────────────────────────

export const Project = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  root: Schema.String,
  command: Command,
  ports: Schema.Array(Port),
  /** Context whose vars are applied when this project is (re)spawned, if any. */
  activeContextId: Schema.optional(ContextId),
  exposure: Schema.optional(Exposure),
  createdAt: Schema.Number,
  updatedAt: Schema.Number
})
export type Project = typeof Project.Type

/** Catalog entry + live runtime view. */
export const ProjectWithState = Schema.Struct({
  ...Project.fields,
  state: RuntimeState,
  pid: Schema.optional(Schema.Int)
})
export type ProjectWithState = typeof ProjectWithState.Type

/** Input to create a project — server assigns id/timestamps. */
export const NewProject = Schema.Struct({
  name: Schema.String,
  root: Schema.String,
  command: Command,
  ports: Schema.optionalWith(Schema.Array(Port), { default: () => [] }),
  exposure: Schema.optional(Exposure)
})
export type NewProject = typeof NewProject.Type

/** Partial mutation to an existing project (catalog.update). */
export const ProjectPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  root: Schema.optional(Schema.String),
  command: Schema.optional(Command),
  ports: Schema.optional(Schema.Array(Port)),
  exposure: Schema.optional(Exposure)
})
export type ProjectPatch = typeof ProjectPatch.Type

// ────────────────────────────────────────────────────────────────────────────
// JSON-RPC framing
// The transport on both ends encodes/decodes these envelopes. Method-specific
// `params`/`result` are Unknown at the frame level; the dispatcher validates
// them against the per-method schemas in core.methods.ts.
// ────────────────────────────────────────────────────────────────────────────

export const RpcId = Schema.Union(Schema.String, Schema.Int)
export type RpcId = typeof RpcId.Type

export const RpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: RpcId,
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
})
export type RpcRequest = typeof RpcRequest.Type

/** id-less frame for server→client pushes (e.g. live event delivery). */
export const RpcNotification = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
})
export type RpcNotification = typeof RpcNotification.Type

export const RpcErrorPayload = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown)
})
export type RpcErrorPayload = typeof RpcErrorPayload.Type

export const RpcSuccess = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: RpcId,
  result: Schema.Unknown
})
export type RpcSuccess = typeof RpcSuccess.Type

export const RpcFailure = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: RpcId,
  error: RpcErrorPayload
})
export type RpcFailure = typeof RpcFailure.Type

export const RpcResponse = Schema.Union(RpcSuccess, RpcFailure)
export type RpcResponse = typeof RpcResponse.Type
