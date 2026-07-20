import { Data } from "effect"

export class SessionNotFoundError extends Data.TaggedError("SessionNotFoundError")<{
  readonly sessionId: string
}> {}

export class PtySpawnError extends Data.TaggedError("PtySpawnError")<{
  readonly errorMessage: string
}> {}
