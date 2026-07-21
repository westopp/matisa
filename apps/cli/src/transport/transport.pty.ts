import { Effect, Option, Queue, Stream } from "effect"
import { ProjectId } from "@matisa/core"
import type { PtySession as PtySessionShape, SessionId } from "@matisa/core"
import { EngineClient } from "./transport.client.js"
import { call } from "./transport.control.js"
import type { TransportError } from "./transport.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// transport.pty — the interactive raw-byte bridge.
//
// Distinct from the durable event path: pty output is live-only, never queued.
// `open` starts a session, puts the terminal in raw mode (Scope-restored on
// exit), pipes stdin→engine (pty.input) and engine→stdout (pty.output pushes),
// and forwards SIGWINCH as pty.resize. Bytes cross the wire base64-encoded so
// they survive the JSON string field.
// ────────────────────────────────────────────────────────────────────────────

// stdin data as a Stream of byte chunks.
const stdinBytes: Stream.Stream<Uint8Array> = Stream.async<Uint8Array>((emit) => {
  const stdin = process.stdin
  const onData = (chunk: Buffer) => emit.single(new Uint8Array(chunk))
  const onEnd = () => emit.end()
  stdin.on("data", onData)
  stdin.once("end", onEnd)
  return Effect.sync(() => {
    stdin.off("data", onData)
    stdin.off("end", onEnd)
  })
})

// SIGWINCH terminal-resize notifications.
const resizes: Stream.Stream<{ cols: number; rows: number }> = Stream.async<{
  cols: number
  rows: number
}>((emit) => {
  const onResize = () =>
    emit.single({
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24
    })
  process.on("SIGWINCH", onResize)
  return Effect.sync(() => {
    process.off("SIGWINCH", onResize)
  })
})

// Classify a push frame for our session: an output chunk or the session exit.
type PtyPush = { readonly _tag: "data"; readonly data: string } | { readonly _tag: "exit" }

const pickFrame =
  (sessionId: SessionId) =>
  (frame: unknown): Option.Option<PtyPush> => {
    const f = frame as {
      method?: string
      params?: { sessionId?: string; data?: string }
    }
    if (f?.params?.sessionId !== sessionId) return Option.none()
    if (f.method === "pty.output" && typeof f.params?.data === "string") {
      return Option.some({ _tag: "data", data: f.params.data })
    }
    if (f.method === "pty.exit") return Option.some({ _tag: "exit" })
    return Option.none()
  }

// Session output until the engine reports the process exited — consuming this
// stream to completion IS the "session ended" signal (raw mode restores, the
// command returns instead of hanging).
const outputUntilExit = <E>(
  notifications: Stream.Stream<unknown, E>,
  sessionId: SessionId
): Stream.Stream<string, E> =>
  notifications.pipe(
    Stream.filterMap(pickFrame(sessionId)),
    Stream.takeWhile((f): f is { _tag: "data"; data: string } => f._tag === "data"),
    Stream.map((f) => f.data)
  )

const rawMode = Effect.acquireRelease(
  Effect.sync(() => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
  }),
  () =>
    Effect.sync(() => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
    })
)

/** Bridge ANY session-opening RPC into a full interactive terminal: raw mode,
 * stdin→pty.input, pty.output→stdout, SIGWINCH→resize, ends on pty.exit.
 * Subscribes BEFORE the RPC — the engine bridges the session onto this
 * connection during the call, so frames can hit the wire ahead of the
 * response; the queue buffers them until the sessionId is known. */
export const interactiveSession = (
  acquire: Effect.Effect<PtySessionShape, TransportError, EngineClient>
): Effect.Effect<void, TransportError, EngineClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* EngineClient

      const inbox = yield* Queue.unbounded<unknown>()
      yield* client.notifications.pipe(
        Stream.runForEach((frame) => Queue.offer(inbox, frame)),
        Effect.forkScoped
      )

      const session = yield* acquire

      yield* rawMode

      const toStdout = outputUntilExit(Stream.fromQueue(inbox), session.sessionId).pipe(
        Stream.runForEach((data) =>
          Effect.sync(() => {
            process.stdout.write(Buffer.from(data, "base64"))
          })
        )
      )

      // Stdin EOF (piped input) must NOT end the session — stop sending and
      // idle so the race is decided by the pty.exit frame in toStdout.
      const fromStdin = stdinBytes.pipe(
        Stream.runForEach((chunk) =>
          call("pty.input", {
            sessionId: session.sessionId,
            data: Buffer.from(chunk).toString("base64")
          })
        ),
        Effect.andThen(Effect.never)
      )

      const onResize = resizes.pipe(
        Stream.runForEach((size) =>
          call("pty.resize", {
            sessionId: session.sessionId,
            cols: size.cols,
            rows: size.rows
          })
        )
      )

      yield* Effect.raceAll([toStdout, fromStdin, onResize])
    })
  )

/** `sh <id>`: open an interactive session and bridge stdio until it ends. */
export const open = (
  projectId: string,
  command: string | undefined,
  cols: number,
  rows: number
): Effect.Effect<void, TransportError, EngineClient> =>
  interactiveSession(
    call("pty.open", { projectId: ProjectId.make(projectId), command, cols, rows })
  )

/** `run <id> <name>`: run a named command as an interactive PTY session. */
export const runCommand = (
  projectId: string,
  name: string,
  cols: number,
  rows: number
): Effect.Effect<void, TransportError, EngineClient> =>
  interactiveSession(
    call("commands.run", { projectId: ProjectId.make(projectId), name, cols, rows })
  )

/** `logs -f <id>`: attach to an existing session's live output stream. */
export const attach = (
  sessionId: SessionId
): Effect.Effect<void, TransportError, EngineClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* EngineClient
      // Same ordering rule as open(): consume into a queue before attaching,
      // or the scrollback replay (written before the RPC response) is lost.
      const inbox = yield* Queue.unbounded<unknown>()
      yield* client.notifications.pipe(
        Stream.runForEach((frame) => Queue.offer(inbox, frame)),
        Effect.forkScoped
      )
      yield* call("pty.attach", { sessionId })
      yield* outputUntilExit(Stream.fromQueue(inbox), sessionId).pipe(
        Stream.runForEach((data) =>
          Effect.sync(() => {
            process.stdout.write(Buffer.from(data, "base64"))
          })
        )
      )
    })
  )
