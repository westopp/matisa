import { Data } from "effect"

// Exposure-internal faults. Mapped onto core wire errors at the handler
// boundary (CaddyUnavailable) or degraded into per-entry `state: "error"`.

/** No caddy binary on PATH or in the Homebrew prefixes. */
export class CaddyBinaryMissing extends Data.TaggedError("CaddyBinaryMissing")<{
  readonly searched: ReadonlyArray<string>
}> {}

/** An admin-API call failed (connection refused, non-2xx, bad JSON). */
export class CaddyAdminError extends Data.TaggedError("CaddyAdminError")<{
  readonly method: string
  readonly path: string
  readonly status?: number
  readonly detail?: string
}> {}

/** dns-sd could not be spawned (missing binary or spawn fault). */
export class MdnsSpawnError extends Data.TaggedError("MdnsSpawnError")<{
  readonly hostname: string
  readonly detail: string
}> {}
