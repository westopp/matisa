import { Layer, Logger, LogLevel } from "effect"

// Structured logging. The pretty logger captures every Effect.log* call with its
// span/log annotations; the minimum level gates noise. (Config-driven level
// wiring via Layer.unwrapEffect is a follow-up; Info is the boot default.)

export const LoggingLive = Layer.merge(
  Logger.pretty,
  Logger.minimumLogLevel(LogLevel.Info)
)
