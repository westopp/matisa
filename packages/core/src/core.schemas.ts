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

// POC: values live in the DB, secrets included. `secret` is a display hint
// (masked in listings). Keychain/secure stores replace this post-POC.
export const EnvVar = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  secret: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
export type EnvVar = typeof EnvVar.Type

/** A named set of environment variables belonging to ONE project (e.g. "dev",
 *  "staging"). There is no such thing as a context without a project, and no
 *  layer that applies to every project: a variable is always reachable by
 *  exactly one project's spawns. `name` is unique within its project, so every
 *  project gets its own "dev" — the id stays globally unique so that a context
 *  is still addressable by a single argument on the CLI. */
export const EnvContext = Schema.Struct({
  id: ContextId,
  projectId: ProjectId,
  name: Schema.String,
  /** The project's always-applied layer, created and destroyed with the project
   *  itself. Exactly one per project; it cannot be renamed or deleted, and the
   *  active context (when there is one) layers over it. */
  isBase: Schema.optionalWith(Schema.Boolean, { default: () => false }),
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
  /** Context layered over this project's base when it is (re)spawned. Must be
   *  one of THIS project's contexts — the engine rejects any other. Unset means
   *  the project spawns on its base alone. */
  activeContextId: Schema.optional(ContextId),
  groupSlug: Schema.optional(GroupSlug),
  /** Absolute path to an image the client shows instead of the generic kind
   *  glyph. A path, not the bytes: the engine reads it on demand (fs.readIcon)
   *  so an icon the user swaps on disk is picked up without a re-add. */
  pathToIcon: Schema.optional(Schema.String),
  /** Whether this project gets a stable Caddy hostname
   *  (http://<slug>.localhost:<caddy-port>). Its own http://localhost:<port> is
   *  unaffected either way, and LAN sharing is a separate switch.
   *
   *  Defaults to true: every project that existed before this flag had one, and
   *  taking URLs away on upgrade would break bookmarks and anything proxying
   *  through them. It is an opt-OUT, for the project that should not be
   *  published at all. */
  stableUrl: Schema.optionalWith(Schema.Boolean, { default: () => true }),
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
  stableUrl: Schema.optionalWith(Schema.Boolean, { default: () => true }),
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
  pathToIcon: Schema.optional(Schema.String),
  /** Decided at creation, so a project never flashes a URL it was not meant to
   *  have. Omitted means the default: exposed — left genuinely optional rather
   *  than defaulted here so a caller building a NewProject is not made to state
   *  a preference it does not have. */
  stableUrl: Schema.optional(Schema.Boolean)
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
  pathToIcon: Schema.optional(Schema.NullOr(Schema.String)),
  stableUrl: Schema.optional(Schema.Boolean)
})
export type ProjectPatch = typeof ProjectPatch.Type

// ────────────────────────────────────────────────────────────────────────────
// Discovery
//
// Everything above describes what the engine OWNS. This block describes what it
// merely SEES: processes and containers on this machine that no matisa runner
// spawned. Two different questions are answered from the same sweep.
//
//   1. "Is a configured project already up, started outside matisa?"  → a
//      ForeignClaim against that project, and the project reads `unmanaged`.
//      This is the redeemable case: the thing on the port is the user's own app.
//   2. "What else is running that matisa knows nothing about?"        → an
//      UnmanagedEntry, which the user can stop, start, or leave alone.
//
// Telling those apart is the whole point, and the discriminator is the process's
// working directory: a pid whose cwd sits inside a project's root is that
// project, whoever launched it. Containers use their name/image instead, since
// a container's cwd is meaningless on the host.
// ────────────────────────────────────────────────────────────────────────────

/** One TCP listener as `lsof` reports it, enriched with what the pid's own
 *  working directory says about where it came from. `cwd` is absent when lsof
 *  could not read it (a process owned by another user, or already gone). */
export const ListeningPort = Schema.Struct({
  pid: Schema.Int,
  /** Process name as lsof reports it — `node`, `python3.12`, `com.docke`. */
  command: Schema.String,
  /** Raw bind address, e.g. `*:5173`, `127.0.0.1:5173`, `[::1]:5173`. */
  address: Schema.String,
  port: Schema.Int,
  /** The pid's working directory. The evidence behind every ownership claim. */
  cwd: Schema.optional(Schema.String),
  /** Name from the nearest manifest at or above `cwd` (package.json, Cargo.toml,
   *  pyproject.toml, go.mod) — what a human would call this thing. */
  appName: Schema.optional(Schema.String)
})
export type ListeningPort = typeof ListeningPort.Type

/** One container as `docker ps -a` reports it. */
export const DiscoveredContainer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  image: Schema.String,
  /** running | exited | created | paused | … */
  state: Schema.String,
  status: Schema.String,
  /** Host-side published ports, parsed out of the CLI's port string. */
  hostPorts: Schema.Array(Schema.Int)
})
export type DiscoveredContainer = typeof DiscoveredContainer.Type

/** One stack as `docker compose ls -a` reports it. */
export const DiscoveredStack = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  /** Absolute path(s) of the compose file(s), comma-joined as docker prints it. */
  configFiles: Schema.String
})
export type DiscoveredStack = typeof DiscoveredStack.Type

/** How confident the engine is that an unmanaged thing is a given project.
 *  `root` — the pid's cwd is inside the project root: this IS the project.
 *  `container` — the container carries the name matisa would have given it.
 *  `port` — nothing but the port number matches, which is a coincidence often
 *  enough that it is reported as the weak evidence it is. */
export const ClaimEvidence = Schema.Literal("root", "container", "port")
export type ClaimEvidence = typeof ClaimEvidence.Type

/** A configured project that is up, run by something other than this engine.
 *  The project reads `unmanaged` for as long as the claim holds. `port`/`pid`
 *  are absent for a container or stack claim — a container's host pid belongs to
 *  the daemon, and a stack has no single port. */
export const ForeignClaim = Schema.Struct({
  projectId: ProjectId,
  projectName: Schema.String,
  port: Schema.optional(Schema.Int),
  pid: Schema.optional(Schema.Int),
  /** Process name, container name, or stack name — whatever is actually holding it. */
  holder: Schema.String,
  cwd: Schema.optional(Schema.String),
  /** What ties the holder to the project — see ClaimEvidence. `root`/`container`
   *  mean "your app, started outside matisa" (take it over); `port` means
   *  "something else is squatting on your port" (investigate first). */
  evidence: ClaimEvidence,
  /** Ready-to-print sentence explaining the claim and what it implies. */
  message: Schema.String
})
export type ForeignClaim = typeof ForeignClaim.Type

export const UnmanagedKind = Schema.Literal("process", "container")
export type UnmanagedKind = typeof UnmanagedKind.Type

/** Something running on this machine that is in no project's catalog entry.
 *  `ref` is the address other RPCs take (`pid:1234`, `container:api-db-1`) —
 *  a stable handle so a client never has to reconstruct one from parts. */
export const UnmanagedEntry = Schema.Struct({
  kind: UnmanagedKind,
  ref: Schema.String,
  /** Manifest name where one was found, else the container/process name. */
  displayName: Schema.String,
  /** The secondary line: image for a container, command for a process. */
  detail: Schema.String,
  pid: Schema.optional(Schema.Int),
  port: Schema.optional(Schema.Int),
  cwd: Schema.optional(Schema.String),
  running: Schema.Boolean
})
export type UnmanagedEntry = typeof UnmanagedEntry.Type

/** One sweep of the machine. `takenAt` is the probe time, not the request time —
 *  a snapshot served from the TTL cache reports when it was actually taken. */
export const DiscoverySnapshot = Schema.Struct({
  takenAt: Schema.Number,
  dockerDaemonRunning: Schema.Boolean,
  claims: Schema.Array(ForeignClaim),
  unmanaged: Schema.Array(UnmanagedEntry)
})
export type DiscoverySnapshot = typeof DiscoverySnapshot.Type

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
