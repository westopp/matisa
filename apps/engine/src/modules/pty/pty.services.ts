import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  PubSub,
  Runtime,
  SynchronizedRef,
  type Scope
} from "effect"
import pty from "node-pty"
import {
  EngineInternal,
  NotFound,
  SessionId,
  type EngineError,
  type ProjectId,
  type PtyInputParams,
  type PtyOpenParams,
  type PtyResizeParams,
  type PtySession
} from "@matisa/core"
import { EnvRepo, ProjectsRepo } from "@matisa/store"
import { SCROLLBACK_MAX_BYTES } from "../../config/config.constants.js"
import { resolveEnv } from "../catalog/catalog.env-resolve.js"
import { toEngineError } from "../../shared/error-map.js"
import { Keychain } from "../catalog/providers/catalog.providers.keychain.types.js"
import { Scrollback, type PtyFrame, type SessionEntry } from "./pty.session.js"

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

export interface PtyManagerShape {
  readonly open: (params: PtyOpenParams) => Effect.Effect<PtySession, EngineError>
  /** Register a session and wire its output into scrollback + hub. */
  readonly register: (input: RegisterInput) => Effect.Effect<void>
  /** Publish the exit frame and mark the session exited (scrollback kept). */
  readonly sessionExited: (sessionId: SessionId, exitCode: number | null) => Effect.Effect<void>
  /** Scrollback snapshot + a live subscription, scoped to the caller. */
  readonly attach: (sessionId: SessionId) => Effect.Effect<AttachSnapshot, EngineError, Scope.Scope>
  readonly input: (params: PtyInputParams) => Effect.Effect<void, EngineError>
  readonly resize: (params: PtyResizeParams) => Effect.Effect<void, EngineError>
}

export class PtyManager extends Context.Tag("PtyManager")<PtyManager, PtyManagerShape>() {}

const sessionNotFound = (sessionId: string): EngineError =>
  new NotFound({ entity: "session", id: sessionId, message: `session not found: ${sessionId}` })

const make = Effect.gen(function* () {
  const projects = yield* ProjectsRepo
  const envRepo = yield* EnvRepo
  const keychain = yield* Keychain
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
        exitCode: null
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
      const replay = entry.scrollback.snapshot()
      return { entry, replay, take: sub.take }
    })

  const open: PtyManagerShape["open"] = (params) =>
    Effect.gen(function* () {
      const project = yield* projects.get(params.projectId).pipe(Effect.mapError(toEngineError))
      const env = yield* resolveEnv(project, { envRepo, keychain }).pipe(
        Effect.catchAll(() => Effect.succeed({} as Record<string, string>))
      )
      const shell = process.env["SHELL"] ?? "/bin/zsh"
      const args: ReadonlyArray<string> =
        params.command === undefined ? ["-i"] : ["-c", params.command]

      const child = yield* Effect.try({
        try: () =>
          pty.spawn(shell, [...args], {
            name: "xterm-256color",
            cols: params.cols,
            rows: params.rows,
            cwd: project.root,
            env: { ...process.env, ...env } as Record<string, string>
          }),
        catch: (cause) => new EngineInternal({ message: `pty spawn failed: ${String(cause)}` })
      })

      const sessionId = SessionId.make(`sh:${project.id}:${child.pid}`)
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
        cols: params.cols,
        rows: params.rows
      })
      registered = true
      if (earlyExit !== undefined) yield* sessionExited(sessionId, earlyExit)

      return { sessionId, projectId: project.id, cols: params.cols, rows: params.rows }
    })

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

  yield* Effect.logInfo("pty module active (node-pty) — run + shell sessions, scrollback, live attach")

  return PtyManager.of({ open, register, sessionExited, attach, input, resize })
})

export const PtyLive = Layer.effect(PtyManager, make)
