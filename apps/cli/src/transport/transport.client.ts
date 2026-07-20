import {
  Context,
  Deferred,
  Effect,
  HashMap,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Stream,
  SynchronizedRef
} from "effect"
import { NodeSocket } from "@effect/platform-node"
import type { RpcId, RpcRequest, RpcResponse } from "@matisa/core"
import { ClientConfig } from "../config/config.client-config.js"
import { EngineUnreachable, RequestTimeout } from "./transport.errors.js"
import type { TransportError } from "./transport.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// transport.client — the wire, owned by a Scope.
//
// EngineClient is a Context.Tag whose Live layer is Layer.scoped. The unix
// socket is connected lazily on first use (so the global --socket override,
// applied by a command handler, is honoured) but always registered against the
// layer scope, so it — and the demux fiber — are released when the CLI exits,
// including on Ctrl-C.
//
// NDJSON JSON-RPC 2.0: one JSON value per line. A single demux fiber parses
// incoming lines; frames carrying an `id` that matches a pending request resolve
// its Deferred, everything else (server pushes / notifications) fans out on a
// PubSub for the event + pty streams.
// ────────────────────────────────────────────────────────────────────────────

export interface Connection {
  readonly request: (frame: RpcRequest) => Effect.Effect<RpcResponse, TransportError>
  readonly stream: (frame: RpcRequest) => Stream.Stream<unknown, TransportError>
  readonly notifications: Stream.Stream<unknown, TransportError>
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, TransportError>
}

export class EngineClient extends Context.Tag("matisa-cli/EngineClient")<
  EngineClient,
  Connection
>() {}

let counter = 0
/** Monotonic per-process JSON-RPC id. */
export const nextRpcId = (): number => ++counter

const encodeLine = (frame: RpcRequest): string => JSON.stringify(frame) + "\n"

// Route one parsed frame: id→pending Deferred, otherwise fan out on the hub.
const routeFrame =
  (
    pending: Ref.Ref<HashMap.HashMap<RpcId, Deferred.Deferred<RpcResponse>>>,
    hub: PubSub.PubSub<unknown>
  ) =>
  (frame: unknown): Effect.Effect<void> =>
    Effect.gen(function* () {
      const f = frame as { id?: unknown }
      if (
        f !== null &&
        typeof f === "object" &&
        (typeof f.id === "number" || typeof f.id === "string")
      ) {
        const map = yield* Ref.get(pending)
        const d = HashMap.get(map, f.id as RpcId)
        if (Option.isSome(d)) {
          yield* Deferred.succeed(d.value, frame as RpcResponse)
          return
        }
      }
      yield* PubSub.publish(hub, frame)
    })

// Open the socket, wire the demux + a "connected" latch, and hand back the
// request/stream primitives. Fails EngineUnreachable if the socket refuses.
const connect = (
  socketPath: string,
  timeout: import("effect/Duration").Duration
): Effect.Effect<Connection, EngineUnreachable, Scope.Scope> =>
  Effect.gen(function* () {
    const socket = yield* NodeSocket.makeNet({ path: socketPath }).pipe(
      Effect.mapError(
        (e) => new EngineUnreachable({ socketPath, cause: String(e) })
      )
    )

    const pending = yield* Ref.make(
      HashMap.empty<RpcId, Deferred.Deferred<RpcResponse>>()
    )
    const hub = yield* PubSub.unbounded<unknown>()
    const frames = yield* Queue.unbounded<unknown>()
    const connected = yield* Deferred.make<void, EngineUnreachable>()

    const write = yield* socket.writer

    // NDJSON demux: buffer bytes, split on newline, offer parsed frames.
    let buffer = ""
    const decoder = new TextDecoder()
    const onData = (chunk: Uint8Array): void => {
      buffer += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim().length === 0) continue
        try {
          Queue.unsafeOffer(frames, JSON.parse(line))
        } catch {
          // Drop a malformed line rather than tear down the connection.
        }
      }
    }

    // Consumer: route frames in arrival order.
    yield* Stream.fromQueue(frames).pipe(
      Stream.runForEach(routeFrame(pending, hub)),
      Effect.forkScoped
    )

    // Reader: opens the connection; onOpen resolves the latch, any failure
    // (refused / dropped) fails it with EngineUnreachable.
    yield* socket.run(onData, {
      onOpen: Deferred.succeed(connected, void 0)
    }).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Deferred.fail(
            connected,
            new EngineUnreachable({ socketPath, cause: String(cause) })
          ),
        onSuccess: () => Effect.void
      }),
      Effect.forkScoped
    )

    // Gate: only surface a Connection once the socket is actually open.
    yield* Deferred.await(connected)

    const writeLine = (frame: RpcRequest) =>
      write(encodeLine(frame)).pipe(
        Effect.mapError(
          (e) => new EngineUnreachable({ socketPath, cause: String(e) })
        )
      )

    const request = (frame: RpcRequest): Effect.Effect<RpcResponse, TransportError> =>
      Effect.gen(function* () {
        const d = yield* Deferred.make<RpcResponse>()
        yield* Ref.update(pending, HashMap.set(frame.id, d))
        yield* writeLine(frame)
        return yield* Deferred.await(d).pipe(
          Effect.timeoutFail({
            duration: timeout,
            onTimeout: () =>
              new RequestTimeout({
                method: frame.method as import("@matisa/core").Method
              })
          }),
          Effect.ensuring(Ref.update(pending, HashMap.remove(frame.id)))
        )
      })

    const notifications: Stream.Stream<unknown, TransportError> = Stream.fromPubSub(hub)

    const stream = (frame: RpcRequest): Stream.Stream<unknown, TransportError> =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const dequeue = yield* PubSub.subscribe(hub)
          yield* writeLine(frame)
          return Stream.fromQueue(dequeue)
        })
      )

    const writeBytes = (bytes: Uint8Array): Effect.Effect<void, TransportError> =>
      write(bytes).pipe(
        Effect.mapError(
          (e) => new EngineUnreachable({ socketPath, cause: String(e) })
        )
      )

    return { request, stream, notifications, write: writeBytes } satisfies Connection
  })

const make = Effect.gen(function* () {
  const config = yield* ClientConfig
  const scope = yield* Effect.scope
  const connRef = yield* SynchronizedRef.make<Option.Option<Connection>>(
    Option.none()
  )

  // Memoized lazy connect, extended onto the layer scope so finalizers run at
  // CLI exit. Runs in the command fiber, so it observes the --socket override.
  const getConn: Effect.Effect<Connection, TransportError> =
    SynchronizedRef.updateAndGetEffect(connRef, (curr) =>
      Option.match(curr, {
        onSome: (c) => Effect.succeed(Option.some(c)),
        onNone: () =>
          Effect.gen(function* () {
            const socketPath = yield* config.socketPath
            const conn = yield* connect(socketPath, config.timeout).pipe(
              Scope.extend(scope)
            )
            return Option.some(conn)
          })
      })
    ).pipe(Effect.map((o) => (o as Option.Some<Connection>).value))

  const request = (frame: RpcRequest) =>
    getConn.pipe(Effect.flatMap((c) => c.request(frame)))

  const stream = (frame: RpcRequest) =>
    Stream.unwrap(getConn.pipe(Effect.map((c) => c.stream(frame))))

  const notifications = Stream.unwrap(
    getConn.pipe(Effect.map((c) => c.notifications))
  )

  const write = (bytes: Uint8Array) =>
    getConn.pipe(Effect.flatMap((c) => c.write(bytes)))

  return EngineClient.of({ request, stream, notifications, write })
})

export const EngineClientBase = Layer.scoped(EngineClient, make)
