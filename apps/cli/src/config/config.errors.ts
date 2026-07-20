import { Data } from "effect"

// Client-config faults. Surfaced by cli.exit as a usage exit code (4): a bad
// socket path / timeout / output mode is an operator mistake, not a runtime
// failure of the engine.
export class InvalidClientConfig extends Data.TaggedError("InvalidClientConfig")<{
  readonly field: string
  readonly value: string
  readonly message: string
}> {}

export type ConfigError = InvalidClientConfig
