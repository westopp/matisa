import { Effect, Scope } from "effect"
import type { Attached, EngineError, SessionId } from "@matisa/core"
import type { PtyManagerShape } from "../modules/pty/pty.services.js"
import type { Connection } from "./server.dispatcher.js"
import { PTY_EXIT_NOTIFY, PTY_OUTPUT_NOTIFY } from "./server.schemas.js"

// ────────────────────────────────────────────────────────────────────────────
// PTY byte bridge — turns a PtyManager session into pty.output / pty.exit push
// frames on a connection. Out of band from the durable event queue: raw bytes,
// live-only, never persisted. Scrollback replays first, then the live pump runs
// as a fiber on the CONNECTION's scope — disconnect interrupts it (no leaks).
// Frames are seq-numbered; the pump skips live seqs already covered by the
// replay so the subscribe/snapshot overlap never duplicates bytes.
// ────────────────────────────────────────────────────────────────────────────

export const bridgeSessionToConnection = (
  ptyMgr: PtyManagerShape,
  sessionId: SessionId,
  conn: Connection
): Effect.Effect<Attached, EngineError> =>
  Effect.gen(function* () {
    const snapshot = yield* ptyMgr
      .attach(sessionId)
      .pipe(Effect.provideService(Scope.Scope, conn.scope))

    let lastSeq = 0
    for (const chunk of snapshot.replay) {
      yield* conn.notify(PTY_OUTPUT_NOTIFY, { sessionId, data: chunk.data })
      lastSeq = chunk.seq
    }

    // A session that already ended still replays, then reports the exit.
    if (snapshot.entry.exited) {
      yield* conn.notify(PTY_EXIT_NOTIFY, { sessionId, exitCode: snapshot.entry.exitCode })
      return { sessionId, cols: snapshot.entry.cols, rows: snapshot.entry.rows }
    }

    const pump: Effect.Effect<void> = Effect.gen(function* () {
      while (true) {
        const frame = yield* snapshot.take
        if (frame.kind === "exit") {
          yield* conn.notify(PTY_EXIT_NOTIFY, { sessionId, exitCode: frame.exitCode })
          return
        }
        if (frame.seq <= lastSeq) continue
        yield* conn.notify(PTY_OUTPUT_NOTIFY, { sessionId, data: frame.data })
      }
    }).pipe(
      // Hub shutdown (session replaced) interrupts `take`; treat as end-of-stream.
      Effect.catchAllCause(() => Effect.void)
    )

    yield* pump.pipe(Effect.forkIn(conn.scope))

    return { sessionId, cols: snapshot.entry.cols, rows: snapshot.entry.rows }
  })
