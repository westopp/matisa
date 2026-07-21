import { Schema } from "effect"
import { EngineEvent } from "./core.events.js"
import {
  CommandVar,
  ContextId,
  DockerDaemonState,
  EnvContext,
  Group,
  GroupSlug,
  Health,
  NamedCommand,
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

/** Create a named environment. The engine derives the id from the name — a
 *  client that invented ids could collide with `base`, which is reserved. */
export const EnvCreateParams = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String)
})
export type EnvCreateParams = typeof EnvCreateParams.Type

export const EnvRenameParams = Schema.Struct({
  contextId: ContextId,
  name: Schema.String
})
export type EnvRenameParams = typeof EnvRenameParams.Type

export const ByContextId = Schema.Struct({ contextId: ContextId })
export type ByContextId = typeof ByContextId.Type

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
  sessionId: Schema.optional(SessionId),
  /** Observed readiness (port probe), orthogonal to `state`. */
  health: Schema.optional(Health)
})
export type RuntimeStatus = typeof RuntimeStatus.Type

/** A persisted launch failure — queryable so clients can always show WHY. */
export const CrashRecord = Schema.Struct({
  projectId: ProjectId,
  ts: Schema.Number,
  exitCode: Schema.optional(Schema.Int),
  signal: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  logTail: Schema.optional(Schema.String)
})
export type CrashRecord = typeof CrashRecord.Type

export const FailuresParams = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  limit: Schema.optionalWith(Schema.Int, { default: () => 20 })
})
export type FailuresParams = typeof FailuresParams.Type

// —— named commands ——

export const CommandSetParams = Schema.Struct({
  projectId: ProjectId,
  name: Schema.String,
  command: Schema.String,
  vars: Schema.optionalWith(Schema.Array(CommandVar), { default: () => [] })
})
export type CommandSetParams = typeof CommandSetParams.Type

export const CommandRefParams = Schema.Struct({
  projectId: ProjectId,
  name: Schema.String
})
export type CommandRefParams = typeof CommandRefParams.Type

export const CommandRunParams = Schema.Struct({
  projectId: ProjectId,
  name: Schema.String,
  cols: Schema.optionalWith(Schema.Int, { default: () => 80 }),
  rows: Schema.optionalWith(Schema.Int, { default: () => 24 })
})
export type CommandRunParams = typeof CommandRunParams.Type

// —— groups ——

export const GroupSetParams = Schema.Struct({
  slug: GroupSlug,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  pathToIcon: Schema.optional(Schema.String)
})
export type GroupSetParams = typeof GroupSetParams.Type

export const BySlug = Schema.Struct({ slug: GroupSlug })
export type BySlug = typeof BySlug.Type

// —— fs ——

export const ListDirParams = Schema.Struct({
  /** Absolute path to list; omitted or empty defaults to the user's home directory. */
  path: Schema.optional(Schema.String)
})
export type ListDirParams = typeof ListDirParams.Type

export const DirEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String
})
export type DirEntry = typeof DirEntry.Type

export const ListDirResult = Schema.Struct({
  path: Schema.String,
  /** Absent once `path` is the filesystem root. */
  parent: Schema.optional(Schema.String),
  entries: Schema.Array(DirEntry)
})
export type ListDirResult = typeof ListDirResult.Type

export const ChooseDirParams = Schema.Struct({
  /** Where the panel opens. Ignored if it no longer exists. */
  defaultPath: Schema.optional(Schema.String)
})
export type ChooseDirParams = typeof ChooseDirParams.Type

export const ChooseDirResult = Schema.Struct({
  /** Absent when the user dismissed the panel — a cancel is not an error. */
  path: Schema.optional(Schema.String)
})
export type ChooseDirResult = typeof ChooseDirResult.Type

export const ChooseFileParams = Schema.Struct({
  defaultPath: Schema.optional(Schema.String),
  /** UTI/extension filter for the panel, e.g. ["png", "svg"]. */
  extensions: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] })
})
export type ChooseFileParams = typeof ChooseFileParams.Type

export const ReadIconParams = Schema.Struct({ path: Schema.String })
export type ReadIconParams = typeof ReadIconParams.Type

/** An icon as a data URI. The client runs in a browser sandbox and cannot read
 *  `file://`, so the engine — which does have disk access — inlines the bytes. */
export const ReadIconResult = Schema.Struct({
  dataUri: Schema.String
})
export type ReadIconResult = typeof ReadIconResult.Type

// —— logs ——

export const LogsTailParams = Schema.Struct({
  projectId: ProjectId,
  lines: Schema.optionalWith(Schema.Int, { default: () => 200 })
})
export type LogsTailParams = typeof LogsTailParams.Type

export const LogsTailResult = Schema.Struct({
  lines: Schema.Array(Schema.String)
})
export type LogsTailResult = typeof LogsTailResult.Type

// —— engine ——

export const EngineStatus = Schema.Struct({
  pid: Schema.Int,
  version: Schema.String,
  startedAt: Schema.Number,
  socketPath: Schema.String,
  dbPath: Schema.String,
  modulesFull: Schema.Array(Schema.String),
  modulesStub: Schema.Array(Schema.String)
})
export type EngineStatus = typeof EngineStatus.Type

// —— docker daemon ——

export const DaemonStatusResult = Schema.Struct({
  state: DockerDaemonState,
  message: Schema.optional(Schema.String)
})
export type DaemonStatusResult = typeof DaemonStatusResult.Type

// —— resources ——

export const ResourceSample = Schema.Struct({
  projectId: ProjectId,
  pid: Schema.optional(Schema.Int),
  cpuPercent: Schema.Number,
  rssBytes: Schema.Number
})
export type ResourceSample = typeof ResourceSample.Type

export const ResourcesSnapshot = Schema.Struct({
  ts: Schema.Number,
  samples: Schema.Array(ResourceSample)
})
export type ResourcesSnapshot = typeof ResourcesSnapshot.Type

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
  "env.create": { params: EnvCreateParams, result: EnvContext },
  "env.rename": { params: EnvRenameParams, result: EnvContext },
  "env.remove": { params: ByContextId, result: Schema.Void },

  "lifecycle.start": { params: ById, result: Accepted },
  "lifecycle.stop": { params: ById, result: Accepted },
  "lifecycle.restart": { params: ById, result: Accepted },
  "lifecycle.status": { params: ById, result: RuntimeStatus },

  "events.subscribe": { params: SubscribeParams, result: SubscribeResult },
  "events.pull": { params: PullParams, result: PullResult },

  "pty.open": { params: PtyOpenParams, result: PtySession },
  "pty.attach": { params: BySessionId, result: Attached },
  "pty.input": { params: PtyInputParams, result: Schema.Void },
  "pty.resize": { params: PtyResizeParams, result: Schema.Void },

  "commands.set": { params: CommandSetParams, result: NamedCommand },
  "commands.list": { params: ById, result: Schema.Array(NamedCommand) },
  "commands.remove": { params: CommandRefParams, result: Schema.Void },
  "commands.run": { params: CommandRunParams, result: PtySession },

  "groups.set": { params: GroupSetParams, result: Group },
  "groups.list": { params: Schema.Void, result: Schema.Array(Group) },
  "groups.remove": { params: BySlug, result: Schema.Void },

  "fs.listDir": { params: ListDirParams, result: ListDirResult },
  "fs.chooseDir": { params: ChooseDirParams, result: ChooseDirResult },
  "fs.chooseFile": { params: ChooseFileParams, result: ChooseDirResult },
  "fs.readIcon": { params: ReadIconParams, result: ReadIconResult },

  "logs.tail": { params: LogsTailParams, result: LogsTailResult },
  "lifecycle.failures": { params: FailuresParams, result: Schema.Array(CrashRecord) },

  "engine.status": { params: Schema.Void, result: EngineStatus },
  "engine.shutdown": { params: Schema.Void, result: Schema.Struct({ accepted: Schema.Boolean }) },

  "docker.daemon.status": { params: Schema.Void, result: DaemonStatusResult },
  "docker.daemon.start": { params: Schema.Void, result: DaemonStatusResult },
  "docker.daemon.stop": { params: Schema.Void, result: DaemonStatusResult },

  "resources.snapshot": { params: Schema.Void, result: ResourcesSnapshot }
} as const satisfies Record<string, { params: Schema.Schema.Any; result: Schema.Schema.Any }>

export type Methods = typeof methods
export type Method = keyof Methods

/** Decoded param type for a method. */
export type Params<M extends Method> = Methods[M]["params"]["Type"]
/** Decoded result type for a method. */
export type Result<M extends Method> = Methods[M]["result"]["Type"]

/** Runtime list of every registered method name. */
export const methodNames = Object.keys(methods) as ReadonlyArray<Method>
