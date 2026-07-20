import { Effect, Exit, Runtime, Scope } from "effect"
import type { Socket } from "node:net"
import { MAX_FRAME_BYTES } from "../config/config.constants.js"
import {
  RPC_INVALID_REQUEST,
  RPC_PARSE_ERROR
} from "./server.errors.js"
import type { Connection, Dispatch } from "./server.dispatcher.js"

// ────────────────────────────────────────────────────────────────────────────
// Per-connection handling. Inbound bytes are split on newlines (NDJSON), each
// complete line decoded + dispatched, and the response written back framed. A
// per-connection CloseableScope backs live subscriptions / PTY attaches; it is
// closed on disconnect so those fibers are interrupted (no leaks). Node event
// callbacks bridge into Effect via the captured Runtime.
// ────────────────────────────────────────────────────────────────────────────

export const handleConnection = (
  socket: Socket,
  dispatch: Dispatch,
  rt: Runtime.Runtime<never>
): void => {
  const scope = Runtime.runSync(rt)(Scope.make())

  const writeFrame = (frame: unknown): void => {
    try {
      socket.write(`${JSON.stringify(frame)}\n`)
    } catch {
      // peer went away mid-write
    }
  }

  const conn: Connection = {
    push: (frame) => Effect.sync(() => writeFrame(frame)),
    notify: (method, params) => Effect.sync(() => writeFrame({ jsonrpc: "2.0", method, params })),
    scope
  }

  let buffer = ""

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")

    if (buffer.length > MAX_FRAME_BYTES) {
      writeFrame({ jsonrpc: "2.0", id: 0, error: { code: RPC_INVALID_REQUEST, message: "frame too large" } })
      buffer = ""
      socket.destroy()
      return
    }

    let newlineAt = buffer.indexOf("\n")
    while (newlineAt >= 0) {
      const line = buffer.slice(0, newlineAt).trim()
      buffer = buffer.slice(newlineAt + 1)

      if (line.length > 0) {
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          writeFrame({ jsonrpc: "2.0", id: 0, error: { code: RPC_PARSE_ERROR, message: "parse error" } })
          newlineAt = buffer.indexOf("\n")
          continue
        }
        Runtime.runFork(rt)(
          dispatch(frame, conn).pipe(Effect.flatMap((response) => Effect.sync(() => writeFrame(response))))
        )
      }

      newlineAt = buffer.indexOf("\n")
    }
  })

  const cleanup = (): void => {
    Runtime.runFork(rt)(Scope.close(scope, Exit.void))
  }
  socket.once("close", cleanup)
  socket.once("error", cleanup)
}
