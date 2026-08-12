import { Data } from "effect"
import type { EngineError, RpcErrorPayload } from "@matisa/core"

// Transport faults + the mapping of core wire errors onto JSON-RPC error codes.
// The dispatcher turns any EngineError into an RpcErrorPayload; unknown methods
// and malformed frames use the reserved JSON-RPC codes.

export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  readonly errorMessage: string
}> {}

export class PayloadTooLargeError extends Data.TaggedError("PayloadTooLargeError")<{
  readonly size: number
}> {}

export class MethodNotFoundError extends Data.TaggedError("MethodNotFoundError")<{
  readonly method: string
}> {}

// JSON-RPC reserved + matisa-specific error codes.
export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL = -32603
export const RPC_NOT_FOUND = -32004
export const RPC_PORT_CONFLICT = -32005
export const RPC_CADDY_UNAVAILABLE = -32006

const codeFor = (err: EngineError): number => {
  switch (err.code) {
    case "E_VALIDATION":
      return RPC_INVALID_PARAMS
    case "E_NOT_FOUND":
      return RPC_NOT_FOUND
    case "E_PORT_CONFLICT":
      return RPC_PORT_CONFLICT
    case "E_CADDY_UNAVAILABLE":
      return RPC_CADDY_UNAVAILABLE
    case "E_INTERNAL":
    default:
      return RPC_INTERNAL
  }
}

export const engineErrorToPayload = (err: EngineError): RpcErrorPayload => ({
  code: codeFor(err),
  message: err.message,
  data: { tag: err._tag, code: err.code }
})
