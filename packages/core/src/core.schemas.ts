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

/** Observed readiness, orthogonal to the FSM `state` (which is kernel truth).
 * `waiting` — spawned, declared port not bound yet. `ready` — port bound.
 * `timeout` — never bound within the start window (process left alone).
 * `unknown` — no declared port, nothing to observe. Probing runs during
 * `starting` only; once ready, the engine hands off and stops watching. */
export const Health = Schema.Literal("waiting", "ready", "timeout", "unknown")
export type Health = typeof Health.Type

/** Docker Desktop daemon lifecycle, owned by the engine's docker module. */
export const DockerDaemonState = Schema.Literal(
  "unknown",
  "stopped",
  "starting",
  "running",
  "start_failed"
)
export type DockerDaemonState = typeof DockerDaemonState.Type

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

/** Reserved context id whose vars are ALWAYS injected, in every environment.
 * The active context layers over it — context wins on key conflicts. */
export const BASE_CONTEXT_ID = "base"

// POC: values live in the DB, secrets included. `secret` is a display hint
// (masked in listings). Keychain/secure stores replace this post-POC.
export const EnvVar = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  secret: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
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
// Named commands
// Ad-hoc tasks attached to a project (tests, migrations, builds) — run on
// demand as PTY sessions via commands.run. A command may carry its own env
// overrides; they belong to the command and are injected on every run of it.
// Precedence, lowest → highest:
//   project base → project active context → command vars
// ────────────────────────────────────────────────────────────────────────────

export const CommandVar = Schema.Struct({
  key: Schema.String,
  value: Schema.String
})
export type CommandVar = typeof CommandVar.Type

export const NamedCommand = Schema.Struct({
  projectId: ProjectId,
  name: Schema.String,
  /** Raw shell line, run via $SHELL -c on a PTY in the project root. */
  command: Schema.String,
  vars: Schema.optionalWith(Schema.Array(CommandVar), { default: () => [] })
})
export type NamedCommand = typeof NamedCommand.Type

// ────────────────────────────────────────────────────────────────────────────
// Groups
// Sidebar/organizational buckets. Standalone entities — projects reference
// them by slug (FK). Purely presentational; no lifecycle semantics.
// ────────────────────────────────────────────────────────────────────────────

export const GroupSlug = Schema.String.pipe(Schema.brand("GroupSlug"))
export type GroupSlug = typeof GroupSlug.Type

export const Group = Schema.Struct({
  slug: GroupSlug,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  pathToIcon: Schema.optional(Schema.String)
})
export type Group = typeof Group.Type

// ────────────────────────────────────────────────────────────────────────────
// Exposure
// How a project's declared port is reachable beyond localhost:<port>. Rows are
// per (project, kind): `stable_url` is derived automatically whenever a port
// is declared (Caddy route on <slug>.localhost); `lan` is the opt-in
// same-network share (mDNS hostname + dedicated LAN-port listener). `tunnel`
// (sish) is reserved, not implemented.
// ────────────────────────────────────────────────────────────────────────────

export const ExposureKind = Schema.Literal("stable_url", "lan")
export type ExposureKind = typeof ExposureKind.Type

export const ExposureEntry = Schema.Struct({
  kind: ExposureKind,
  /** The address a browser can open, e.g. http://api.localhost:7777. */
  url: Schema.String,
  enabled: Schema.Boolean,
  /** `unavailable` = provider missing (no caddy binary / no LAN interface). */
  state: Schema.Literal("active", "error", "unavailable"),
  message: Schema.optional(Schema.String)
})
export type ExposureEntry = typeof ExposureEntry.Type

// ────────────────────────────────────────────────────────────────────────────
// Project
// The persisted catalog entry. `Project` is the stored shape; `ProjectWithState`
// layers the live FSM-observed runtime state + pid on top for read models.
//
// `kind` discriminates how the supervisor runs it:
//   process — a local dev server spawned on a PTY (`command` required)
//   docker  — a single container the engine runs/reuses (`image` required);
//             containers are named `matisa.<name>`, started with
//             `--restart unless-stopped` (docker owns restarts, the FSM
//             observes real state via `docker events`)
//   compose — a whole stack delegated to `docker compose` (`composeFile`
//             required); the stack is the lifecycle unit
// ────────────────────────────────────────────────────────────────────────────

export const ProjectKind = Schema.Literal("process", "docker", "compose")
export type ProjectKind = typeof ProjectKind.Type

const kindFieldsValid = <A extends { kind: ProjectKind; command?: unknown; image?: unknown; composeFile?: unknown; ports?: ReadonlyArray<unknown> }>(p: A): boolean =>
  ((p.kind === "process" && p.command !== undefined) ||
    (p.kind === "docker" && typeof p.image === "string") ||
    (p.kind === "compose" && typeof p.composeFile === "string")) &&
  // Process projects run one dev server on one port — the port is a contract
  // (health probe + reverse-proxy upstream). Docker/compose stacks keep the
  // array (web + db + admin UI are all legitimate listeners).
  (p.kind !== "process" || (p.ports?.length ?? 0) <= 1)

const kindMessage =
  "process requires `command` and at most one port; docker requires `image`; compose requires `composeFile`"

export const Project = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  root: Schema.String,
  kind: Schema.optionalWith(ProjectKind, { default: () => "process" as const }),
  /** process: how to spawn. Unused for docker/compose. */
  command: Schema.optional(Command),
  /** docker: the image to run as `matisa.<name>`. */
  image: Schema.optional(Schema.String),
  /** compose: absolute path to the docker-compose file. */
  composeFile: Schema.optional(Schema.String),
  ports: Schema.Array(Port),
  /** Context whose vars are applied when this project is (re)spawned, if any. */
  activeContextId: Schema.optional(ContextId),
  groupSlug: Schema.optional(GroupSlug),
  /** Absolute path to an image the client shows instead of the generic kind
   *  glyph. A path, not the bytes: the engine reads it on demand (fs.readIcon)
   *  so an icon the user swaps on disk is picked up without a re-add. */
  pathToIcon: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number
}).pipe(Schema.filter(kindFieldsValid, { message: () => kindMessage }))
export type Project = typeof Project.Type

const projectFields = {
  id: ProjectId,
  name: Schema.String,
  root: Schema.String,
  kind: Schema.optionalWith(ProjectKind, { default: () => "process" as const }),
  command: Schema.optional(Command),
  image: Schema.optional(Schema.String),
  composeFile: Schema.optional(Schema.String),
  ports: Schema.Array(Port),
  activeContextId: Schema.optional(ContextId),
  groupSlug: Schema.optional(GroupSlug),
  pathToIcon: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number
}

/** Catalog entry + live runtime view. */
export const ProjectWithState = Schema.Struct({
  ...projectFields,
  state: RuntimeState,
  pid: Schema.optional(Schema.Int),
  health: Schema.optional(Health)
})
export type ProjectWithState = typeof ProjectWithState.Type

/** Input to create a project — server assigns id/timestamps. */
export const NewProject = Schema.Struct({
  name: Schema.String,
  root: Schema.String,
  kind: Schema.optionalWith(ProjectKind, { default: () => "process" as const }),
  command: Schema.optional(Command),
  image: Schema.optional(Schema.String),
  composeFile: Schema.optional(Schema.String),
  ports: Schema.optionalWith(Schema.Array(Port), { default: () => [] }),
  groupSlug: Schema.optional(GroupSlug),
  pathToIcon: Schema.optional(Schema.String)
}).pipe(Schema.filter(kindFieldsValid, { message: () => kindMessage }))
export type NewProject = typeof NewProject.Type

/** Partial mutation to an existing project (catalog.update). Fields that can be
 *  cleared are nullable: `undefined` keeps what is stored, `null` erases it. */
export const ProjectPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  root: Schema.optional(Schema.String),
  command: Schema.optional(Command),
  image: Schema.optional(Schema.String),
  composeFile: Schema.optional(Schema.String),
  ports: Schema.optional(Schema.Array(Port)),
  groupSlug: Schema.optional(Schema.NullOr(GroupSlug)),
  pathToIcon: Schema.optional(Schema.NullOr(Schema.String))
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
