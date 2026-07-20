import { Cause, Console, Effect, Match, Option } from "effect"
import type { TransportError } from "./transport/transport.index.js"
import type { ConfigError } from "./config/config.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// cli.exit — the scripting contract.
//
// A total Match over the app's tagged-error union → stable exit codes so scripts
// can branch on $?. Every failure in the app is a Data.TaggedError (nothing is
// thrown), so the mapping is exhaustive and compiler-checked: adding an error
// forces a code decision here.
//
//   0   ok            2  engine unreachable   3  rpc error / timeout
//   4   usage/config  5  not found           130 interrupt (Ctrl-C)
// ────────────────────────────────────────────────────────────────────────────

export type AppError = TransportError | ConfigError

const renderError = (err: AppError): string =>
  Match.value(err).pipe(
    Match.tag(
      "EngineUnreachable",
      (e) => `engine unreachable at ${e.socketPath}: ${e.cause}`
    ),
    Match.tag("RequestTimeout", (e) => `request timed out: ${e.method}`),
    Match.tag(
      "RpcError",
      (e) => `engine error (${e.tag ?? e.code}) on ${e.method}: ${e.message}`
    ),
    Match.tag("ProtocolError", (e) => `protocol error on ${e.method}: ${e.message}`),
    Match.tag("NotFound", (e) => `not found: ${e.entity} ${e.id} — ${e.message}`),
    Match.tag(
      "InvalidClientConfig",
      (e) => `invalid config ${e.field}=${e.value}: ${e.message}`
    ),
    Match.exhaustive
  )

const codeFor = (err: AppError): number =>
  Match.value(err).pipe(
    Match.tag("EngineUnreachable", () => 2),
    Match.tag("RpcError", () => 3),
    Match.tag("RequestTimeout", () => 3),
    Match.tag("InvalidClientConfig", () => 4),
    Match.tag("ProtocolError", () => 4),
    Match.tag("NotFound", () => 5),
    Match.exhaustive
  )

export const exitCodeFor = (cause: Cause.Cause<AppError>): Effect.Effect<number> =>
  Effect.gen(function* () {
    if (Cause.isInterruptedOnly(cause)) return 130
    const failure = Cause.failureOption(cause)
    if (Option.isNone(failure)) {
      yield* Console.error(Cause.pretty(cause))
      return 1
    }
    const err = failure.value
    yield* Console.error(renderError(err))
    return codeFor(err)
  })
