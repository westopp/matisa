import { Data, Effect, Exit, Runtime, Scope } from "effect"
import * as http from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import { MAX_FRAME_BYTES } from "../config/config.constants.js"
import { RPC_INVALID_REQUEST, RPC_PARSE_ERROR } from "./server.errors.js"
import type { Connection, Dispatch } from "./server.dispatcher.js"

// ────────────────────────────────────────────────────────────────────────────
// The WebSocket bridge — the same JSON-RPC surface as the unix socket, over a
// loopback TCP port, because a browser cannot open a UDS. One WS message is one
// frame (no NDJSON splitting), and each connection gets its own CloseableScope
// backing live subscriptions / PTY attaches exactly as server.connection.ts does.
//
// Bound to 127.0.0.1 only, and the Origin header is checked against loopback, so
// a page on the open internet cannot drive the engine through a user's browser.
// "file://" is the Electron shell's packaged renderer (a file:// document sends
// exactly that) — a local file is inside the trust boundary the same way a
// local process on the unix socket is.
// ────────────────────────────────────────────────────────────────────────────

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

const originAllowed = (origin: string | undefined): boolean =>
  origin === undefined || origin === "null" || origin === "file://" || LOOPBACK_ORIGIN.test(origin)

const handleSocket = (ws: WebSocket, dispatch: Dispatch, rt: Runtime.Runtime<never>): void => {
  const scope = Runtime.runSync(rt)(Scope.make())

  const writeFrame = (frame: unknown): void => {
    if (ws.readyState !== ws.OPEN) return
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // peer went away mid-write
    }
  }

  const conn: Connection = {
    push: (frame) => Effect.sync(() => writeFrame(frame)),
    notify: (method, params) => Effect.sync(() => writeFrame({ jsonrpc: "2.0", method, params })),
    scope
  }

  ws.on("message", (raw: Buffer | ArrayBuffer | Array<Buffer>) => {
    const text = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw as Buffer).toString("utf8")

    if (text.length > MAX_FRAME_BYTES) {
      writeFrame({ jsonrpc: "2.0", id: 0, error: { code: RPC_INVALID_REQUEST, message: "frame too large" } })
      ws.close()
      return
    }

    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      writeFrame({ jsonrpc: "2.0", id: 0, error: { code: RPC_PARSE_ERROR, message: "parse error" } })
      return
    }

    Runtime.runFork(rt)(
      dispatch(frame, conn).pipe(Effect.flatMap((response) => Effect.sync(() => writeFrame(response))))
    )
  })

  const cleanup = (): void => {
    Runtime.runFork(rt)(Scope.close(scope, Exit.void))
  }
  ws.once("close", cleanup)
  ws.once("error", cleanup)
}

/** Another engine already owns the loopback port. Not a fault: the engine is a
 * shared singleton daemon and clients race to start it — the loser exits
 * cleanly and everyone connects to the winner. */
export class EngineAlreadyRunning extends Data.TaggedError("EngineAlreadyRunning")<{
  readonly port: number
}> {}

/** Bind the loopback port as the SINGLE-INSTANCE MUTEX, before anything else
 * touches shared state (the DB, the unix socket file). Nothing is served yet —
 * upgrades are only handled once attachWsBridge wires the dispatcher after
 * reconciliation, so a client connecting into the gap is dropped and retries.
 * Returns null when the bridge is disabled (port 0) — no mutex, dev's choice. */
export const acquireWsMutex = (
  port: number
): Effect.Effect<http.Server | null, EngineAlreadyRunning, Scope.Scope> =>
  port === 0
    ? Effect.succeed(null)
    : Effect.acquireRelease(
        Effect.async<http.Server, EngineAlreadyRunning>((resume) => {
          const server = http.createServer((_req, res) => {
            res.writeHead(426, { "content-type": "text/plain" })
            res.end("upgrade required")
          })
          server.once("error", (err) =>
            resume(
              (err as NodeJS.ErrnoException).code === "EADDRINUSE"
                ? Effect.fail(new EngineAlreadyRunning({ port }))
                : Effect.die(err)
            )
          )
          server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)))
        }),
        (server) => Effect.sync(() => server.close())
      )

/** Start serving the JSON-RPC surface on the already-bound listener. */
export const attachWsBridge = (
  server: http.Server,
  dispatch: Dispatch,
  rt: Runtime.Runtime<never>
): Effect.Effect<void> =>
  Effect.sync(() => {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
    server.on("upgrade", (req, socket, head) => {
      if (!originAllowed(req.headers.origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => handleSocket(ws, dispatch, rt))
    })
  })
