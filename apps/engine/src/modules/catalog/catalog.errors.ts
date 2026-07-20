import { Data } from "effect"

// Catalog-domain faults. These are internal; the service maps them (and store
// faults) onto the four @matisa/core wire errors at its boundary.

export class DuplicateNameError extends Data.TaggedError("DuplicateNameError")<{
  readonly name: string
}> {}

export class PortTakenError extends Data.TaggedError("PortTakenError")<{
  readonly port: number
  readonly heldBy?: string
}> {}

export class UnknownContextWarning extends Data.TaggedError("UnknownContextWarning")<{
  readonly contextId: string
}> {}
