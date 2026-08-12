import { Context, Duration, Effect, FiberRef, Layer, Option } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import { InvalidClientConfig } from "./config.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// ClientConfig — the client's resolved runtime settings.
//
// Socket path, request timeout and output mode are decoded from the environment
// at layer build (a bad value fails loud here, not mid-command). Socket path and
// output mode are held in FiberRefs so the global `--socket` / `--json` flags,
// parsed later by @effect/cli, can override them within the command fiber before
// the transport lazily connects.
// ────────────────────────────────────────────────────────────────────────────

export type OutputMode = "table" | "json"

export interface ClientConfigService {
  /** Resolved unix-socket path (global --socket overrides MATISA_SOCK). */
  readonly socketPath: Effect.Effect<string>
  /** Resolved output mode (global --json forces "json"). */
  readonly outputMode: Effect.Effect<OutputMode>
  /** Per-request timeout. */
  readonly timeout: Duration.Duration
  /** Apply the global --socket override, if provided. */
  readonly setSocket: (override: Option.Option<string>) => Effect.Effect<void>
  /** Apply the global --json override. */
  readonly setJson: (json: boolean) => Effect.Effect<void>
  /** --ensure-engine: spawn the engine if the socket is unreachable. */
  readonly ensureEngine: Effect.Effect<boolean>
  readonly setEnsure: (ensure: boolean) => Effect.Effect<void>
}

export class ClientConfig extends Context.Tag("matisa-cli/ClientConfig")<
  ClientConfig,
  ClientConfigService
>() {}

/** Default socket location the engine listens on when MATISA_SOCK is unset —
 * the same MATISA_ROOT resolution the engine uses, so a bare `matisa` finds a
 * bare engine no matter which directory either was started from. */
export const defaultSocketPath = (): string =>
  path.join(process.env.MATISA_ROOT ?? path.join(os.homedir(), ".matisa"), "engine.sock")

const resolveTimeout = (
  raw: string | undefined
): Effect.Effect<Duration.Duration, InvalidClientConfig> => {
  if (raw === undefined) return Effect.succeed(Duration.seconds(30))
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) {
    return Effect.fail(
      new InvalidClientConfig({
        field: "MATISA_TIMEOUT_MS",
        value: raw,
        message: "MATISA_TIMEOUT_MS must be a positive number of milliseconds"
      })
    )
  }
  return Effect.succeed(Duration.millis(ms))
}

const resolveOutput = (
  raw: string | undefined
): Effect.Effect<OutputMode, InvalidClientConfig> => {
  if (raw === undefined) return Effect.succeed("table")
  if (raw === "table" || raw === "json") return Effect.succeed(raw)
  return Effect.fail(
    new InvalidClientConfig({
      field: "MATISA_OUTPUT",
      value: raw,
      message: 'MATISA_OUTPUT must be "table" or "json"'
    })
  )
}

const make = Effect.gen(function* () {
  const env = process.env
  const socket = env.MATISA_SOCK ?? defaultSocketPath()
  const timeout = yield* resolveTimeout(env.MATISA_TIMEOUT_MS)
  const output = yield* resolveOutput(env.MATISA_OUTPUT)

  const socketRef = yield* FiberRef.make(socket)
  const outputRef = yield* FiberRef.make<OutputMode>(output)
  const ensureRef = yield* FiberRef.make(false)

  return ClientConfig.of({
    socketPath: FiberRef.get(socketRef),
    outputMode: FiberRef.get(outputRef),
    timeout,
    setSocket: (override) =>
      Option.match(override, {
        onNone: () => Effect.void,
        onSome: (s) => FiberRef.set(socketRef, s)
      }),
    setJson: (json) => (json ? FiberRef.set(outputRef, "json") : Effect.void),
    ensureEngine: FiberRef.get(ensureRef),
    setEnsure: (ensure) => FiberRef.set(ensureRef, ensure)
  })
})

// Layer.scoped: FiberRef.make is scope-bound; the config lives for the CLI run.
export const ClientConfigLive = Layer.scoped(ClientConfig, make)
