import { Data } from "effect"
import type { Method } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// The wire error channel.
//
// Every failure the transport can produce is a Data.TaggedError — nothing is
// thrown. cli.exit does a total Match over this union (+ ConfigError) to derive
// the stable scripting exit codes.
// ────────────────────────────────────────────────────────────────────────────

/** Could not reach / stay connected to the engine socket. Exit 2. */
export class EngineUnreachable extends Data.TaggedError("EngineUnreachable")<{
  readonly socketPath: string
  readonly cause: string
}> {}

/** A request outlived the configured timeout. Exit 3. */
export class RequestTimeout extends Data.TaggedError("RequestTimeout")<{
  readonly method: Method
}> {}

/** The engine answered with a JSON-RPC error frame. Exit 3. */
export class RpcError extends Data.TaggedError("RpcError")<{
  readonly method: Method
  readonly code: number
  readonly tag: string | undefined
  readonly message: string
}> {}

/** A frame failed schema encode/decode or was malformed JSON. Exit 4. */
export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  readonly method: Method | "frame"
  readonly message: string
}> {}

/** The engine reported a referenced entity does not exist (E_NOT_FOUND). Exit 5. */
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly entity: string
  readonly id: string
  readonly message: string
}> {}

export type TransportError =
  | EngineUnreachable
  | RequestTimeout
  | RpcError
  | ProtocolError
  | NotFound
