import { Schema } from "effect"
import { EngineEvent } from "./core.events.js"
import {
  CommandVar,
  ContextId,
  DiscoverySnapshot,
  DockerDaemonState,
  EnvContext,
  ExposureEntry,
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

/** Delete one variable from a context. Distinct from env.remove, which drops an
 *  entire context — this is the notepad's line-deletion primitive. */
export const EnvUnsetParams = Schema.Struct({
  contextId: ContextId,
  key: Schema.String
})
export type EnvUnsetParams = typeof EnvUnsetParams.Type

export const EnvUseParams = Schema.Struct({
  projectId: ProjectId,
  contextId: ContextId
})
export type EnvUseParams = typeof EnvUseParams.Type

/** Create a named environment for a project. `projectId` is required and has no
 *  "none" — an environment that belonged to no project would be one whose
 *  variables no project could be held responsible for, which is exactly the
 *  global layer this schema no longer has. The engine derives the id from the
 *  name; the name only has to be unique within the project. */
export const EnvCreateParams = Schema.Struct({
  projectId: ProjectId,
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

/** A start (or restart) with an optional one-off environment.
 *
 *  `context` is a REF — a context id, or the context's name, matched
 *  case-insensitively within this project. Names are only unique inside a
 *  project, which is exactly the scope this param already has, so an agent can
 *  say `staging` rather than carry a uuid.
 *
 *  It applies to THIS spawn only and does not touch `activeContextId`. That is
 *  the whole point: `env.use` is a persistent selection, and an agent that
 *  switched it to run one thing in staging would leave the project pointed at
 *  staging after it exits — or race a second agent doing the same. A per-spawn
 *  override has no state to restore and nothing to race.
 *
 *  Absent means the stored selection, which is what every existing caller
 *  sends. */
export const StartParams = Schema.Struct({
  id: ProjectId,
  context: Schema.optional(Schema.String)
})
export type StartParams = typeof StartParams.Type


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

/** Which half of the failure vocabulary a record belongs to. `crash` — the
 *  child ran and exited non-zero. `error` — the engine could not manage it at
 *  all (spawn refused, port held, docker/compose declined, restarts exhausted),
 *  which is the `errored` runtime state rather than `crashed`. The two are
 *  actioned differently, so the record says which it was instead of leaving a
 *  client to infer it from a missing exit code. */
export const FailureKind = Schema.Literal("crash", "error")
export type FailureKind = typeof FailureKind.Type

/** A persisted launch failure — queryable so clients can always show WHY. */
export const CrashRecord = Schema.Struct({
  projectId: ProjectId,
  ts: Schema.Number,
  /** Defaulted, not required: rows written before the column existed are
   *  process crashes, which is what the table originally held. */
  kind: Schema.optionalWith(FailureKind, { default: () => "crash" as const }),
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

/** Forget recorded failures — one project's, or every project's when the id is
 *  omitted. The crash history is a record kept FOR the user; once it has been
 *  read it is theirs to discard. Nothing running is touched. */
export const ClearFailuresParams = Schema.Struct({
  projectId: Schema.optional(ProjectId)
})
export type ClearFailuresParams = typeof ClearFailuresParams.Type

export const ClearedResult = Schema.Struct({ cleared: Schema.Int })
export type ClearedResult = typeof ClearedResult.Type

export const TakeoverParams = Schema.Struct({
  id: ProjectId,
  /** Proceed even when the only thing tying the holder to the project is the
   *  port number. Off by default: see lifecycle.takeover. */
  force: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
export type TakeoverParams = typeof TakeoverParams.Type

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
  rows: Schema.optionalWith(Schema.Int, { default: () => 24 }),
  /** One-off environment for this run, same ref rules as `StartParams`. The
   *  command's own vars still layer on top of it — they are configured on the
   *  command and belong to every run of it, whichever context it runs in. */
  context: Schema.optional(Schema.String)
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

/** Show a path in the OS file manager. Selects the entry in its parent folder
 *  rather than opening it — "reveal", not "open with". */
export const RevealParams = Schema.Struct({ path: Schema.String })
export type RevealParams = typeof RevealParams.Type

/** One project root the engine was refused. `name` travels with it because the
 *  window names projects, not paths, and the engine is the only side that can
 *  pair the two without a second call. */
export const DeniedRoot = Schema.Struct({
  projectId: ProjectId,
  name: Schema.String,
  root: Schema.String
})
export type DeniedRoot = typeof DeniedRoot.Type

/** What the engine can actually reach of its own catalog.
 *
 *  This exists because of how a TCC denial presents: the engine spawns every
 *  project with `cwd` set to its root, so a root the engine may not read makes
 *  `getcwd(2)` fail in the child and Node dies with `EPERM: uv_cwd` before it
 *  reads a line of the project. Nothing raises a prompt — macOS denies a
 *  process that lacks the grant silently — so without this the failure is a
 *  project that will not start and no statement anywhere of why.
 *
 *  `supported` is false off macOS, where there is no TCC and therefore nothing
 *  to grant or to report. */
export const FileAccessResult = Schema.Struct({
  supported: Schema.Boolean,
  denied: Schema.Array(DeniedRoot),
  checkedAt: Schema.Number
})
export type FileAccessResult = typeof FileAccessResult.Type

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

// —— exposure ——

/** Runtime status of the Caddy provider. `available` = binary found;
 * `running` = the engine-owned instance is up and serving routes. */
export const CaddyStatus = Schema.Struct({
  available: Schema.Boolean,
  running: Schema.Boolean,
  httpPort: Schema.Int,
  /** Primary non-loopback IPv4, when a LAN interface is up. */
  lanIp: Schema.optional(Schema.String)
})
export type CaddyStatus = typeof CaddyStatus.Type

export const ProjectExposures = Schema.Struct({
  projectId: ProjectId,
  entries: Schema.Array(ExposureEntry)
})
export type ProjectExposures = typeof ProjectExposures.Type

export const ExposureSnapshot = Schema.Struct({
  caddy: CaddyStatus,
  projects: Schema.Array(ProjectExposures)
})
export type ExposureSnapshot = typeof ExposureSnapshot.Type

export const ExposureLanSetParams = Schema.Struct({
  id: ProjectId,
  enabled: Schema.Boolean
})
export type ExposureLanSetParams = typeof ExposureLanSetParams.Type

export const ExposureEntries = Schema.Struct({
  entries: Schema.Array(ExposureEntry)
})
export type ExposureEntries = typeof ExposureEntries.Type

// —— discovery ——

/** A sweep costs a handful of `lsof`/`docker` shell-outs, so results are cached
 *  briefly and concurrent callers share one probe. `refresh` forces a new sweep
 *  — the honest thing to send right after acting on what a snapshot reported. */
export const DiscoverySnapshotParams = Schema.Struct({
  refresh: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
export type DiscoverySnapshotParams = typeof DiscoverySnapshotParams.Type

/** Address an unmanaged thing by the `ref` its snapshot entry carried. */
export const ByRef = Schema.Struct({ ref: Schema.String })
export type ByRef = typeof ByRef.Type

export const DiscoveryActionResult = Schema.Struct({
  ref: Schema.String,
  /** What the entry is doing now, as observed after the action. */
  running: Schema.Boolean,
  message: Schema.String
})
export type DiscoveryActionResult = typeof DiscoveryActionResult.Type

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

// —— git ——
//
// Matisa is not a git client and this is not a step towards being one. It reads
// where a project's checkout is standing and offers the three moves you would
// otherwise leave the app to make — fetch, pull, switch branch. Anything else,
// including everything that can conflict, belongs in a terminal.

/** Where a project's working copy is standing. Absent `repoRoot` means the
 *  project's root is not inside a git repository at all, which is a normal
 *  answer and not an error. */
export const GitContext = Schema.Struct({
  projectId: ProjectId,
  /** The repository this project sits in. Several projects in a monorepo share
   *  one, and they therefore share a branch — a client that draws this per card
   *  must not imply otherwise. */
  repoRoot: Schema.optional(Schema.String),
  /** Absent on a detached HEAD, where `head` carries the short sha instead. */
  branch: Schema.optional(Schema.String),
  head: Schema.optional(Schema.String),
  /** Commits this branch has that its upstream does not, and the reverse. Both
   *  absent when the branch is not tracking anything. */
  ahead: Schema.optional(Schema.Int),
  behind: Schema.optional(Schema.Int),
  /** Uncommitted changes in the working tree. Read on demand only — it costs a
   *  full `git status`, unlike everything else here. */
  dirty: Schema.optional(Schema.Boolean)
})
export type GitContext = typeof GitContext.Type

export const GitStatusParams = Schema.Struct({
  id: ProjectId,
  /** Include the working-tree flag. Off by default: it is the only field here
   *  that costs a scan of the checkout. */
  dirty: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
export type GitStatusParams = typeof GitStatusParams.Type

export const GitBranches = Schema.Struct({
  current: Schema.optional(Schema.String),
  local: Schema.Array(Schema.String)
})
export type GitBranches = typeof GitBranches.Type

export const GitCheckoutParams = Schema.Struct({
  id: ProjectId,
  branch: Schema.String
})
export type GitCheckoutParams = typeof GitCheckoutParams.Type

/** What a fetch, pull or checkout did. `ok: false` is a REPORT, not a thrown
 *  error: git refusing to switch a dirty tree is the ordinary case, the user
 *  knows what to do about it, and matisa's job is to say what git said and get
 *  out of the way. `context` is the state afterwards, so a client never has to
 *  follow an action with a read. */
export const GitActionResult = Schema.Struct({
  ok: Schema.Boolean,
  /** git's own output, trimmed — never paraphrased. */
  message: Schema.String,
  context: GitContext
})
export type GitActionResult = typeof GitActionResult.Type

// —— settings ——

/** Which events are allowed to interrupt, and how far the interruption reaches.
 *  Per-type rather than one switch: the events differ by how much they deserve
 *  a person's attention. A crash is worth a notification; a project you started
 *  reaching `running` is a thing you already know. */
export const NotificationPrefs = Schema.Struct({
  /** The master switch. Off means silent, whatever the per-type flags say. */
  enabled: Schema.Boolean,
  crashed: Schema.Boolean,
  stateChanged: Schema.Boolean,
  healthChanged: Schema.Boolean,
  /** Escalate to an OS notification when the window does not have focus. Off
   *  keeps everything in-app, where an unfocused window means you miss it. */
  osWhenUnfocused: Schema.Boolean
})
export type NotificationPrefs = typeof NotificationPrefs.Type

/** Everything global, in one document.
 *
 *  Stored as one settings row per top-level key (see SettingsRepo), assembled
 *  and defaulted by the engine so that no client has to know which keys have
 *  been written yet. Clients read the whole thing and PATCH a field — there is
 *  no partial read, because the document is small and a half-read document is
 *  how two clients end up disagreeing about what the settings are. */
export const Settings = Schema.Struct({
  /** Free text, handed to agents verbatim by `matisa operations-instructions`.
   *  Matisa does not parse it, enforce it, or know what is in it — the rules
   *  are between the user and their agent. */
  operationsInstructions: Schema.String,
  notifications: NotificationPrefs,
  /** Out of the fleet, not out of the catalog. Hidden projects still run, still
   *  count, and are still listed by the CLI — an agent must never inherit a
   *  human's decision to tidy something off their own screen. */
  hiddenProjects: Schema.Array(ProjectId),
  hiddenGroups: Schema.Array(Schema.String)
})
export type Settings = typeof Settings.Type

/** A patch: every field optional, absent fields left alone. Sending the whole
 *  document back would make every save a last-writer-wins overwrite of fields
 *  the sender never looked at. */
export const SettingsPatch = Schema.partial(Settings)
export type SettingsPatch = typeof SettingsPatch.Type

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
  "env.unset": { params: EnvUnsetParams, result: EnvContext },
  "env.list": { params: Schema.Void, result: Schema.Array(EnvContext) },
  "env.use": { params: EnvUseParams, result: ProjectWithState },
  "env.create": { params: EnvCreateParams, result: EnvContext },
  "env.rename": { params: EnvRenameParams, result: EnvContext },
  "env.remove": { params: ByContextId, result: Schema.Void },

  "lifecycle.start": { params: StartParams, result: Accepted },
  "lifecycle.stop": { params: ById, result: Accepted },
  "lifecycle.restart": { params: StartParams, result: Accepted },
  /** Force a project down NOW: SIGKILL the group (or `rm -f` the container)
   *  without a drain, then drop the runner without waiting on it. The escape
   *  hatch for a stop that will not finish — `lifecycle.stop` is the polite
   *  door and this is the one that always opens. Unclean by construction: the
   *  process gets no chance to flush, so it is a user's decision, never the
   *  engine's. */
  "lifecycle.kill": { params: ById, result: Accepted },
  /** Acknowledge a terminal failure: `crashed`/`errored` → `idle`. Nothing is
   *  started, stopped or signalled — there is no process on either side of it.
   *  A no-op from any other state, so a stale click can never disturb something
   *  that is actually alive. */
  "lifecycle.reset": { params: ById, result: Accepted },
  /** Reclaim a project that is already up outside matisa: stop whatever holds
   *  its declared port, then start it under the engine. Refuses when the holder
   *  is only circumstantially linked to the project (evidence `port`) unless
   *  `force` is set — killing a stranger's process on a port-number coincidence
   *  is the one mistake this command must not make on its own. */
  "lifecycle.takeover": { params: TakeoverParams, result: Accepted },
  "lifecycle.status": { params: ById, result: RuntimeStatus },

  "events.subscribe": { params: SubscribeParams, result: SubscribeResult },
  "events.pull": { params: PullParams, result: PullResult },

  "pty.open": { params: PtyOpenParams, result: PtySession },
  "pty.attach": { params: BySessionId, result: Attached },
  "pty.input": { params: PtyInputParams, result: Schema.Void },
  "pty.resize": { params: PtyResizeParams, result: Schema.Void },
  /** Kill a shell/command session. Never valid for a `run:` session — a project
   *  is stopped through lifecycle.stop, not by closing a terminal. */
  "pty.close": { params: BySessionId, result: Schema.Void },
  /** Drop a session's scrollback. The process is untouched — this clears the
   *  RECORD, so a later attach replays nothing from before the clear. Valid for
   *  every session kind: clearing a view never affects what is running. */
  "pty.clear": { params: BySessionId, result: Schema.Void },

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
  "fs.reveal": { params: RevealParams, result: Schema.Void },
  /** Which catalog roots the engine is refused by the OS. Read by the window on
   *  connect and whenever it regains focus — a grant is made in System Settings,
   *  outside this app, so focus is the one moment the answer can have changed
   *  without the window doing anything. */
  "fs.access": { params: Schema.Void, result: FileAccessResult },

  "logs.tail": { params: LogsTailParams, result: LogsTailResult },
  "lifecycle.failures": { params: FailuresParams, result: Schema.Array(CrashRecord) },
  "lifecycle.clearFailures": { params: ClearFailuresParams, result: ClearedResult },

  "engine.status": { params: Schema.Void, result: EngineStatus },
  "engine.shutdown": { params: Schema.Void, result: Schema.Struct({ accepted: Schema.Boolean }) },

  "docker.daemon.status": { params: Schema.Void, result: DaemonStatusResult },
  "docker.daemon.start": { params: Schema.Void, result: DaemonStatusResult },
  "docker.daemon.stop": { params: Schema.Void, result: DaemonStatusResult },

  "resources.snapshot": { params: Schema.Void, result: ResourcesSnapshot },

  "discovery.snapshot": { params: DiscoverySnapshotParams, result: DiscoverySnapshot },
  /** Stop an unmanaged process (SIGTERM to its group, then SIGKILL) or
   *  container (`docker stop`). Nothing is adopted — the engine ends something
   *  it does not own because the user asked it to, and says so. */
  "discovery.stop": { params: ByRef, result: DiscoveryActionResult },
  /** Start a stopped unmanaged container. Containers only: a dead process has
   *  no command left to re-run, which is precisely what a catalog entry is for. */
  "discovery.start": { params: ByRef, result: DiscoveryActionResult },

  "exposure.snapshot": { params: Schema.Void, result: ExposureSnapshot },
  "exposure.lan.set": { params: ExposureLanSetParams, result: ExposureEntries },

  /** Read-only, and cheap: two plumbing commands, no working-tree scan. Pass
   *  `dirty: true` to pay for a status as well. */
  "git.context": { params: GitStatusParams, result: GitContext },
  "git.branches": { params: ById, result: GitBranches },
  "git.fetch": { params: ById, result: GitActionResult },
  "git.pull": { params: ById, result: GitActionResult },
  "git.checkout": { params: GitCheckoutParams, result: GitActionResult },

  "settings.get": { params: Schema.Void, result: Settings },
  /** Patch and read back. The result is the whole document after the write, so
   *  a client never has to follow a save with a fetch to know what it saved
   *  into. */
  "settings.set": { params: SettingsPatch, result: Settings }
} as const satisfies Record<string, { params: Schema.Schema.Any; result: Schema.Schema.Any }>

export type Methods = typeof methods
export type Method = keyof Methods

/** Decoded param type for a method. */
export type Params<M extends Method> = Methods[M]["params"]["Type"]
/** Decoded result type for a method. */
export type Result<M extends Method> = Methods[M]["result"]["Type"]

/** Runtime list of every registered method name. */
export const methodNames = Object.keys(methods) as ReadonlyArray<Method>
