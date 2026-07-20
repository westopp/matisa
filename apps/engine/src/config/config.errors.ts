import { Data } from "effect"

// Config faults are Data.TaggedError channels. main.ts catches InvalidConfigError
// at the top of the program and turns it into a fatal log + Effect.die — a bad
// config never reaches a use-site.

export class InvalidConfigError extends Data.TaggedError("InvalidConfigError")<{
  readonly errorMessage: string
}> {}

export class MissingConfigError extends Data.TaggedError("MissingConfigError")<{
  readonly key: string
}> {}
