import { Data } from "effect"

// ────────────────────────────────────────────────────────────────────────────
// Store faults — Data.TaggedError channels, never thrown.
//
// These are the STORE-internal failure shapes. They are distinct from the
// wire errors in @matisa/core: the engine maps a ConstraintError/PortConflict
// here onto core's PortConflict, a store NotFound onto core's NotFound, etc.
// A raw better-sqlite3 throw is always caught and re-surfaced as one of these.
// ────────────────────────────────────────────────────────────────────────────

/** Any better-sqlite3 call (prepare/run/get/all/exec/transaction) that threw. */
export class StoreQueryError extends Data.TaggedError("StoreQueryError")<{
  readonly cause: unknown
  readonly query?: string
}> {}

/** A migration file failed to apply. */
export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly version: string
  readonly cause: unknown
}> {}

/** A referenced row (project, context, …) does not exist. */
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly entity: string
  readonly id: string
}> {}

/** A host port is already claimed (strict global port uniqueness). The holder's
 *  name rides along with its id: the id is what a client links to, the name is
 *  the only half of it a human can act on. */
export class PortConflict extends Data.TaggedError("PortConflict")<{
  readonly port: number
  readonly heldBy?: string
  readonly heldByName?: string
}> {}

/** Union of every fault a repository method may fail with. */
export type StoreError = StoreQueryError | MigrationError | NotFound | PortConflict
