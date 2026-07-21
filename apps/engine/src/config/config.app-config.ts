import { Context, Effect, Layer, ParseResult, Schema } from "effect"
import * as C from "./config.constants.js"
import { InvalidConfigError } from "./config.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// AppConfig — the typed, boot-validated configuration service. Reads env on top
// of platform defaults into an Effect Schema; a bad config fails at boot via
// InvalidConfigError (caught in main.ts), never at a use-site. Every service
// depends on this tag, so nothing runs against an invalid config.
// ────────────────────────────────────────────────────────────────────────────

const ConfigSchema = Schema.Struct({
  socketPath: Schema.String,
  /** Loopback WebSocket bridge port; 0 disables the bridge entirely. */
  wsPort: Schema.Number,
  dbPath: Schema.String,
  logLevel: Schema.Literal("debug", "info", "warn", "error"),
  backoff: Schema.Struct({
    base: Schema.Number,
    cap: Schema.Number,
    maxAttempts: Schema.Number
  }),
  caddyAdminPort: Schema.Number,
  sish: Schema.Struct({
    server: Schema.String,
    keyPath: Schema.String
  })
})

export type AppConfigShape = typeof ConfigSchema.Type

const gatherEnvAndDefaults = (): unknown => ({
  socketPath: process.env.MATISA_SOCK ?? C.DEFAULT_SOCKET_PATH,
  wsPort: Number(process.env.MATISA_WS_PORT ?? C.DEFAULT_WS_PORT),
  dbPath: process.env.MATISA_DB ?? C.DEFAULT_DB_PATH,
  logLevel: process.env.MATISA_LOG_LEVEL ?? "info",
  backoff: {
    base: Number(process.env.MATISA_BACKOFF_BASE ?? C.DEFAULT_BACKOFF.base),
    cap: Number(process.env.MATISA_BACKOFF_CAP ?? C.DEFAULT_BACKOFF.cap),
    maxAttempts: Number(process.env.MATISA_BACKOFF_MAX ?? C.DEFAULT_BACKOFF.maxAttempts)
  },
  caddyAdminPort: Number(process.env.MATISA_CADDY_PORT ?? C.CADDY_ADMIN_PORT),
  sish: {
    server: process.env.MATISA_SISH_SERVER ?? "tuns.sh",
    keyPath: process.env.MATISA_SISH_KEY ?? `${C.MATISA_ROOT}/sish_ed25519`
  }
})

export class AppConfig extends Context.Tag("AppConfig")<AppConfig, AppConfigShape>() {
  static readonly Live = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const raw = gatherEnvAndDefaults()
      return yield* Schema.decodeUnknown(ConfigSchema)(raw).pipe(
        Effect.mapError(
          (e) =>
            new InvalidConfigError({ errorMessage: ParseResult.TreeFormatter.formatErrorSync(e) })
        )
      )
    })
  )
}
