import { Data } from "effect"

// Supervisor faults. The per-project fiber catches these into machine events; it
// never throws. ProjectNotFoundError is the only one that escapes to a caller
// (mapped to a core NotFound); the rest drive Fault → Errored transitions.

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly projectId: string
  readonly errorMessage: string
}> {}

export class StartTimeoutError extends Data.TaggedError("StartTimeoutError")<{
  readonly projectId: string
}> {}

export class HealthTimeoutError extends Data.TaggedError("HealthTimeoutError")<{
  readonly projectId: string
}> {}

export class ProjectNotFoundError extends Data.TaggedError("ProjectNotFoundError")<{
  readonly projectId: string
}> {}
