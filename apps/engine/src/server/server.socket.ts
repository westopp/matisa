import { Context, Effect, Layer } from "effect"
import * as net from "node:net"
import { mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { AppConfig } from "../config/config.app-config.js"
import { reconcile } from "../modules/supervisor/supervisor.reconcile.js"
import { handleConnection } from "./server.connection.js"
import { makeDispatcher } from "./server.dispatcher.js"
import { makeHandlers } from "./handlers/handlers.index.js"
import { acquireWsMutex, attachWsBridge } from "./server.ws.js"

// ────────────────────────────────────────────────────────────────────────────
// SocketServer — the UDS listener as a scoped Layer. Acquire reconciles runtime
// state (so it is coherent before clients connect), unlinks any stale socket,
// binds the unix socket, and forks the accept loop; each accepted connection runs
// in its own Scope. Release closes the listener and unlinks the socket. Because
// this is the last layer built, state is already coherent when it opens.
// ────────────────────────────────────────────────────────────────────────────

export interface SocketServerShape {
  readonly address: string
}

export class SocketServer extends Context.Tag("SocketServer")<SocketServer, SocketServerShape>() {}

const make = Effect.gen(function* () {
  const config = yield* AppConfig

  // The loopback port is the single-instance mutex, taken BEFORE reconciliation
  // and before the stale-socket unlink below: a raced second engine must fail
  // here (EngineAlreadyRunning → clean exit in main.ts) while it has still
  // touched nothing the winner is using.
  const wsServer = yield* acquireWsMutex(config.wsPort)

  const handlers = yield* makeHandlers
  const dispatch = makeDispatcher(handlers)
  const rt = yield* Effect.runtime<never>()

  // Boot reconciliation runs before the socket binds.
  yield* reconcile

  const socketPath = config.socketPath

  yield* Effect.acquireRelease(
    Effect.async<net.Server>((resume) => {
      try {
        rmSync(socketPath, { force: true })
      } catch {
        // nothing to unlink
      }
      mkdirSync(dirname(socketPath), { recursive: true })
      const server = net.createServer((socket) => handleConnection(socket, dispatch, rt))
      server.once("error", (err) => resume(Effect.die(err)))
      server.listen(socketPath, () => resume(Effect.succeed(server)))
    }),
    (server) =>
      Effect.sync(() => {
        server.close()
        try {
          rmSync(socketPath, { force: true })
        } catch {
          // already gone
        }
      })
  )

  // The GUI's transport. Same dispatcher, same handlers — only the framing
  // differs. The listener has been bound (as the mutex) since before
  // reconciliation; only now does it start serving upgrades.
  if (wsServer !== null) yield* attachWsBridge(wsServer, dispatch, rt)

  yield* Effect.logInfo(`matisa engine listening on ${socketPath}`)
  if (config.wsPort !== 0) {
    yield* Effect.logInfo(`ws bridge listening on ws://127.0.0.1:${config.wsPort}`)
  }
  yield* Effect.logInfo(
    "modules — FULL: catalog, supervisor (lifecycle + takeover), events, pty (run + shell sessions), exposure (caddy + mdns), docker, discovery (unmanaged processes + containers)"
  )

  return SocketServer.of({ address: socketPath })
})

export const ServerLive = Layer.scoped(SocketServer, make)
