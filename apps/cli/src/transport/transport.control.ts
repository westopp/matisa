import { Effect, Schema } from "effect"
import { methods } from "@matisa/core"
import type { Method, Params, Result } from "@matisa/core"
import { EngineClient, nextRpcId } from "./transport.client.js"
import { NotFound, ProtocolError, RpcError } from "./transport.errors.js"
import type { TransportError } from "./transport.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// transport.control — one typed caller for every method.
//
// `call` derives its param/result types from the shared `methods` registry in
// @matisa/core, so renaming a method or changing a field is a compile error at
// every call site. Params are Schema-encoded outbound and the result is
// Schema-decoded inbound — no per-command wire code, no hand-duplicated shapes.
// ────────────────────────────────────────────────────────────────────────────

const engineErrorToTransport = (
  method: Method,
  error: { readonly code: number; readonly message: string; readonly data?: unknown }
): TransportError => {
  const data = error.data as
    | { _tag?: string; entity?: string; id?: string; message?: string }
    | undefined
  if (data?._tag === "NotFound") {
    return new NotFound({
      entity: data.entity ?? "entity",
      id: data.id ?? "",
      message: data.message ?? error.message
    })
  }
  return new RpcError({
    method,
    code: error.code,
    tag: data?._tag,
    message: error.message
  })
}

export const call = <M extends Method>(
  method: M,
  params: Params<M>
): Effect.Effect<Result<M>, TransportError, EngineClient> =>
  Effect.gen(function* () {
    const client = yield* EngineClient
    const spec = methods[method]

    const encoded = yield* Schema.encode(spec.params as Schema.Schema<Params<M>, unknown>)(
      params
    ).pipe(
      Effect.mapError(
        (e) => new ProtocolError({ method, message: `encode params: ${e.message}` })
      )
    )

    const res = yield* client.request({
      jsonrpc: "2.0",
      id: nextRpcId(),
      method,
      params: encoded
    })

    if ("error" in res) {
      return yield* Effect.fail(engineErrorToTransport(method, res.error))
    }

    return yield* Schema.decode(spec.result as Schema.Schema<Result<M>, unknown>)(
      res.result
    ).pipe(
      Effect.mapError(
        (e) => new ProtocolError({ method, message: `decode result: ${e.message}` })
      )
    )
  })
