import {
  Context,
  Duration,
  Effect,
  HashMap,
  Layer,
  Option,
  PubSub,
  Runtime,
  Schedule,
  SynchronizedRef,
  type Scope
} from "effect"
import pty from "node-pty"
import {
  EngineInternal,
  NotFound,
  SessionId,
  ValidationError,
  type EngineError,
  type Project,
  type ProjectId,
  type PtyInputParams,
  type PtyOpenParams,
  type PtyResizeParams,
  type PtySession
} from "@matisa/core"
import { EnvRepo, ProjectsRepo } from "@matisa/store"
import {
  SCROLLBACK_MAX_BYTES,
  SHELL_IDLE_REAP_MS,
  SHELL_REAP_INTERVAL_MS
} from "../../config/config.constants.js"
import { resolveEnv } from "../catalog/catalog.env-resolve.js"
import { toEngineError } from "../../shared/error-map.js"
import {
  RUN_PREFIX,
  SHELL_PREFIX,
  Scrollback,
  type PtyFrame,
  type SessionEntry
} from "./pty.session.js"

// ────────────────────────────────────────────────────────────────────────────
// PtyManager — the registry of every live pseudo-terminal (tmux model).
//
// Two session kinds share one registry: "run" sessions are the supervised
// processes themselves (registered by the supervisor — interacting with the
// managed service is a core requirement, not an add-on), and "shell" sessions
// are ad-hoc terminals from pty.open. Output fans out through a per-session
// PubSub of seq-numbered frames; a byte-capped scrollback ring lets a late
// attach replay history, and the pump dedupes by skipping seq ≤ last replayed.
// Exited sessions keep their scrollback for post-mortem attach until the next
// register of the same id (project restart) replaces them.
//
// Sessions outliving their client is the POINT of the tmux model — close a
// pane, reload the page, reconnect, and the shell is still there. What is not
// the point is a shell outliving everything that could ever reach it again:
// each one is a real $SHELL process, and a browser reload used to strand one
// permanently. Three bounds, so the model survives without the leak:
//   • `close`  — an explicit kill, so a closed terminal is actually closed
//   • reaper   — `sh:` sessions detached for SHELL_IDLE_REAP_MS are unreachable
//                by definition; `cmd:` and `run:` are doing work and are exempt
//   • teardown — no shell outlives the engine that spawned it
// ────────────────────────────────────────────────────────────────────────────

export interface RegisterInput {
  readonly sessionId: SessionId
  readonly projectId: ProjectId
  readonly kind: "run" | "shell"
  readonly pty: pty.IPty
  readonly cols: number
  readonly rows: number
}

export interface AttachSnapshot {
  readonly entry: SessionEntry
  /** Scrollback to replay before consuming the live subscription. */
  readonly replay: ReadonlyArray<{ readonly seq: number; readonly data: string }>
  /** Take one live frame — from a subscription scoped to the caller. */
  readonly take: Effect.Effect<PtyFrame>
}

export interface OpenSessionInput {
  readonly project: Project
  readonly sessionId: SessionId
  /** Raw shell line run via $SHELL -c; omit for an interactive shell. */
  readonly command?: string
  readonly cols: number
  readonly rows: number
  /** Layered over the project's resolved env (command vars, etc). */
  readonly extraEnv?: Record<string, string>
}

export interface PtyManagerShape {
  readonly open: (params: PtyOpenParams) => Effect.Effect<PtySession, EngineError>
  /** Open a session with full control (id, extra env) — commands.run path. */
  readonly openSession: (input: OpenSessionInput) => Effect.Effect<PtySession, EngineError>
  /** Register a session and wire its output into scrollback + hub. */
  readonly register: (input: RegisterInput) => Effect.Effect<void>
  /** Publish the exit frame and mark the session exited (scrollback kept). */
  readonly sessionExited: (sessionId: SessionId, exitCode: number | null) => Effect.Effect<void>
  /** Scrollback snapshot + a live subscription, scoped to the caller. */
  readonly attach: (sessionId: SessionId) => Effect.Effect<AttachSnapshot, EngineError, Scope.Scope>
  readonly input: (params: PtyInputParams) => Effect.Effect<void, EngineError>
  readonly resize: (params: PtyResizeParams) => Effect.Effect<void, EngineError>
  /** Kill a session and mark it exited. Refuses `run:` sessions — those belong
   *  to the supervisor, and closing a terminal must never stop a project. */
  readonly close: (sessionId: SessionId) => Effect.Effect<void, EngineError>
  /** Drop a session's scrollback. The process is untouched — unlike `close`,
   *  this is safe for every session kind, including `run:`. */
  readonly clear: (sessionId: SessionId) => Effect.Effect<void, EngineError>
  /** Last lines of a session's decoded scrollback ("" if unknown session). */
  readonly scrollbackTail: (sessionId: SessionId, maxLines: number) => Effect.Effect<string>
  /** Live (non-exited) sessions whose id starts with `prefix`. */
  readonly liveSessionCount: (prefix: string) => Effect.Effect<number>
}

export class PtyManager extends Context.Tag("PtyManager")<PtyManager, PtyManagerShape>() {}

const sessionNotFound = (sessionId: string): EngineError =>
  new NotFound({ entity: "session", id: sessionId, message: `session not found: ${sessionId}` })

const make = Effect.gen(function* () {
  const projects = yield* ProjectsRepo
  const envRepo = yield* EnvRepo
  const rt = yield* Effect.runtime<never>()

  const sessions = yield* SynchronizedRef.make(HashMap.empty<string, SessionEntry>())

  const lookup = (sessionId: string): Effect.Effect<SessionEntry, EngineError> =>
    SynchronizedRef.get(sessions).pipe(
      Effect.flatMap((map) =>
        Option.match(HashMap.get(map, sessionId), {
          onNone: () => Effect.fail(sessionNotFound(sessionId)),
          onSome: (entry) => Effect.succeed(entry)
        })
      )
    )

  const register: PtyManagerShape["register"] = (input) =>
    Effect.gen(function* () {
      const hub = yield* PubSub.unbounded<PtyFrame>()
      const entry: SessionEntry = {
        sessionId: input.sessionId,
        projectId: input.projectId,
        kind: input.kind,
        pty: input.pty,
        hub,
        scrollback: new Scrollback(SCROLLBACK_MAX_BYTES),
        cols: input.cols,
        rows: input.rows,
        exited: false,
        exitCode: null,
        attachments: 0,
        detachedAt: Date.now()
      }
      // Node callback → Effect boundary: the scrollback append is sync so the
      // seq counter stays ordered; the hub publish is forked on the runtime.
      input.pty.onData((chunk) => {
        const { seq, data } = entry.scrollback.push(chunk)
        Runtime.runFork(rt)(PubSub.publish(hub, { kind: "data", seq, data }))
      })
      // Re-registering an id (project restart) shuts the old hub down so any
      // attached pumps complete instead of hanging on a dead session.
      yield* SynchronizedRef.updateEffect(sessions, (map) =>
        Effect.gen(function* () {
          const prior = HashMap.get(map, input.sessionId as string)
          if (Option.isSome(prior)) yield* PubSub.shutdown(prior.value.hub)
          return HashMap.set(map, input.sessionId as string, entry)
        })
      )
    })

  const sessionExited: PtyManagerShape["sessionExited"] = (sessionId, exitCode) =>
    Effect.gen(function* () {
      const map = yield* SynchronizedRef.get(sessions)
      const entry = HashMap.get(map, sessionId as string)
      if (Option.isNone(entry)) return
      entry.value.exited = true
      entry.value.exitCode = exitCode
      yield* PubSub.publish(entry.value.hub, {
        kind: "exit",
        seq: entry.value.scrollback.bumpSeq(),
        exitCode
      })
    })

  const attach: PtyManagerShape["attach"] = (sessionId) =>
    Effect.gen(function* () {
      const entry = yield* lookup(sessionId as string)
      // Subscribe FIRST, then snapshot: a chunk landing in between shows up in
      // both, and the pump dedupes by seq.
      const sub = yield* PubSub.subscribe(entry.hub)
      // Attachment accounting rides the CALLER's scope, which for a bridged
      // client is its connection — so a dropped socket decrements this without
      // anyone remembering to. It is the only evidence the reaper has that a
      // shell still has an audience.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          entry.attachments += 1
        }),
        () =>
          Effect.sync(() => {
            entry.attachments = Math.max(0, entry.attachments - 1)
            if (entry.attachments === 0) entry.detachedAt = Date.now()
          })
      )
      const replay = entry.scrollback.snapshot()
      return { entry, replay, take: sub.take }
    })

  /** Kill the pty and publish the exit. Idempotent: an already-exited session
   *  is left as it is, scrollback intact for a post-mortem attach. */
  const killEntry = (entry: SessionEntry): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (entry.exited) return
      yield* Effect.sync(() => {
        try {
          entry.pty.kill()
        } catch {
          // already gone
        }
      })
      // Do not wait for onExit to come back around: the caller asked for this
      // session to be over, and the registry must agree immediately.
      yield* sessionExited(entry.sessionId, null)
    })

  const close: PtyManagerShape["close"] = (sessionId) =>
    Effect.gen(function* () {
      const id = sessionId as string
      if (id.startsWith(RUN_PREFIX)) {
        return yield* Effect.fail(
          new ValidationError({
            message: `session ${id} is a supervised run — stop the project instead of closing its terminal`
          })
        )
      }
      const entry = yield* lookup(id)
      yield* killEntry(entry)
    })

  // Clearing is a view operation that happens to be persisted: the pty keeps
  // running and keeps publishing, only the replay history is dropped. No `run:`
  // guard, because nothing about a project's process depends on the record of
  // what it printed.
  const clear: PtyManagerShape["clear"] = (sessionId) =>
    Effect.gen(function* () {
      const entry = yield* lookup(sessionId as string)
      yield* Effect.sync(() => entry.scrollback.clear())
    })

  const openSession: PtyManagerShape["openSession"] = (input) =>
    Effect.gen(function* () {
      const project = input.project
      const env = yield* resolveEnv(project, { envRepo }).pipe(
        Effect.catchAll(() => Effect.succeed({} as Record<string, string>))
      )
      const shell = process.env["SHELL"] ?? "/bin/zsh"
      const args: ReadonlyArray<string> =
        input.command === undefined ? ["-i"] : ["-c", input.command]

      const child = yield* Effect.try({
        try: () =>
          pty.spawn(shell, [...args], {
            name: "xterm-256color",
            cols: input.cols,
            rows: input.rows,
            cwd: project.root,
            env: { ...process.env, ...env, ...(input.extraEnv ?? {}) } as Record<string, string>
          }),
        catch: (cause) => new EngineInternal({ message: `pty spawn failed: ${String(cause)}` })
      })

      const sessionId = input.sessionId
      // Listen BEFORE register — a `-c` one-liner can exit before registration
      // lands, and onExit fires only once. Buffer it and flush after register.
      let earlyExit: number | null | undefined
      let registered = false
      child.onExit(({ exitCode }) => {
        if (registered) Runtime.runFork(rt)(sessionExited(sessionId, exitCode))
        else earlyExit = exitCode
      })
      yield* register({
        sessionId,
        projectId: project.id,
        kind: "shell",
        pty: child,
        cols: input.cols,
        rows: input.rows
      })
      registered = true
      if (earlyExit !== undefined) yield* sessionExited(sessionId, earlyExit)

      return { sessionId, projectId: project.id, cols: input.cols, rows: input.rows }
    })

  const open: PtyManagerShape["open"] = (params) =>
    Effect.gen(function* () {
      const project = yield* projects.get(params.projectId).pipe(Effect.mapError(toEngineError))
      return yield* openSession({
        project,
        sessionId: SessionId.make(`sh:${project.id}:${Date.now() % 1_000_000}`),
        command: params.command,
        cols: params.cols,
        rows: params.rows
      })
    })

  const scrollbackTail: PtyManagerShape["scrollbackTail"] = (sessionId, maxLines) =>
    Effect.gen(function* () {
      const map = yield* SynchronizedRef.get(sessions)
      const entry = HashMap.get(map, sessionId as string)
      if (Option.isNone(entry)) return ""
      const text = entry.value.scrollback
        .snapshot()
        .map((c) => Buffer.from(c.data, "base64").toString("utf8"))
        .join("")
      return text.split("\n").slice(-maxLines).join("\n")
    })

  const liveSessionCount: PtyManagerShape["liveSessionCount"] = (prefix) =>
    SynchronizedRef.get(sessions).pipe(
      Effect.map((map) => {
        let n = 0
        for (const [id, entry] of map) {
          if (id.startsWith(prefix) && !entry.exited) n++
        }
        return n
      })
    )

  const input: PtyManagerShape["input"] = (params) =>
    Effect.gen(function* () {
      const entry = yield* lookup(params.sessionId as string)
      if (entry.exited) return yield* Effect.fail(sessionNotFound(params.sessionId as string))
      yield* Effect.try({
        try: () => entry.pty.write(Buffer.from(params.data, "base64").toString("utf8")),
        catch: (cause) => new EngineInternal({ message: `pty write failed: ${String(cause)}` })
      })
    })

  const resize: PtyManagerShape["resize"] = (params) =>
    Effect.gen(function* () {
      const entry = yield* lookup(params.sessionId as string)
      if (entry.exited) return
      yield* Effect.sync(() => {
        try {
          entry.pty.resize(params.cols, params.rows)
          entry.cols = params.cols
          entry.rows = params.rows
        } catch {
          // exited between lookup and resize — the attach pump surfaces the exit
        }
      })
    })

  /** Sessions no client can reach any more. Only `sh:` qualifies: a `cmd:`
   *  session is running something the user asked for, and a `run:` session is
   *  the project itself. */
  const reapIdleShells: Effect.Effect<void> = Effect.gen(function* () {
    const map = yield* SynchronizedRef.get(sessions)
    const cutoff = Date.now() - SHELL_IDLE_REAP_MS
    for (const [id, entry] of map) {
      if (!id.startsWith(SHELL_PREFIX)) continue
      if (entry.exited || entry.attachments > 0 || entry.detachedAt > cutoff) continue
      yield* Effect.logInfo(
        `pty: reaping shell ${id} — unattached for ${SHELL_IDLE_REAP_MS / 60_000} minutes`
      )
      yield* killEntry(entry)
    }
  })

  yield* reapIdleShells.pipe(
    Effect.catchAllCause(() => Effect.void),
    Effect.repeat(Schedule.spaced(Duration.millis(SHELL_REAP_INTERVAL_MS))),
    Effect.forkScoped
  )

  // No shell outlives the engine. Run sessions are left alone — the supervisor
  // owns those, and its own teardown drains them properly.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const map = yield* SynchronizedRef.get(sessions)
      let killed = 0
      for (const [id, entry] of map) {
        if (id.startsWith(RUN_PREFIX) || entry.exited) continue
        yield* killEntry(entry)
        killed += 1
      }
      if (killed > 0) yield* Effect.logInfo(`pty: killed ${killed} session(s) on shutdown`)
    }).pipe(Effect.catchAllCause(() => Effect.void))
  )

  yield* Effect.logInfo("pty module active (node-pty) — run + shell sessions, scrollback, live attach")

  return PtyManager.of({
    open,
    openSession,
    register,
    sessionExited,
    attach,
    input,
    resize,
    close,
    clear,
    scrollbackTail,
    liveSessionCount
  })
})

export const PtyLive = Layer.scoped(PtyManager, make)
