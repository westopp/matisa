import { Effect, Either, ParseResult, Schema, type Scope } from "effect"
import {
  RpcRequest,
  methods,
  type EngineError,
  type Method,
  type RpcId,
  type RpcResponse
} from "@matisa/core"
import {
  engineErrorToPayload,
  RPC_INTERNAL,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND
} from "./server.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// The inbound contract choke point. Every frame is Schema-decoded against the
// core method registry, routed to a namespace handler, and the result
// Schema-encoded — tagged errors become JSON-RPC error objects. Nothing crosses
// the socket that isn't derived from @matisa/core (contracts-single-source).
// ────────────────────────────────────────────────────────────────────────────

/** A live client connection — the handler-visible surface (push + scope). */
export interface Connection {
  readonly push: (frame: unknown) => Effect.Effect<void>
  readonly notify: (method: string, params: unknown) => Effect.Effect<void>
  readonly scope: Scope.CloseableScope
}

/** A namespace handler: decoded params in, a domain result or EngineError out. */
export type Handler = (params: unknown, conn: Connection) => Effect.Effect<unknown, EngineError>

export type Handlers = Record<Method, Handler>

export type Dispatch = (raw: unknown, conn: Connection) => Effect.Effect<RpcResponse>

const ok = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result })

const fail = (id: RpcId, code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message }
})

const idOf = (raw: unknown): RpcId => {
  const rid = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined
  return typeof rid === "string" || typeof rid === "number" ? rid : 0
}

export const makeDispatcher = (handlers: Handlers): Dispatch => {
  return (raw, conn) =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknown(RpcRequest)(raw).pipe(Effect.either)
      if (Either.isLeft(request)) {
        return fail(idOf(raw), RPC_INVALID_REQUEST, "invalid JSON-RPC request")
      }
      const req = request.right

      if (!(req.method in handlers)) {
        return fail(req.id, RPC_METHOD_NOT_FOUND, `method not found: ${req.method}`)
      }
      const method = req.method as Method

      // The registry entry is a union of per-method schemas; erase it to a generic
      // Schema so decode/encode infer uniformly. The wire boundary is `unknown`.
      const paramSchema = methods[method].params as unknown as Schema.Schema<unknown, unknown, never>
      const params = yield* Schema.decodeUnknown(paramSchema)(req.params).pipe(Effect.either)
      if (Either.isLeft(params)) {
        return fail(
          req.id,
          RPC_INVALID_PARAMS,
          `invalid params: ${ParseResult.TreeFormatter.formatErrorSync(params.left)}`
        )
      }

      const outcome = yield* handlers[method](params.right, conn).pipe(Effect.either)
      if (Either.isLeft(outcome)) {
        return { jsonrpc: "2.0", id: req.id, error: engineErrorToPayload(outcome.left) }
      }

      const resultSchema = methods[method].result as unknown as Schema.Schema<unknown, unknown, never>
      const encoded = yield* Schema.encode(resultSchema)(outcome.right).pipe(Effect.either)
      if (Either.isLeft(encoded)) {
        return fail(req.id, RPC_INTERNAL, "failed to encode result")
      }
      return ok(req.id, encoded.right)
    })
}
