import { Effect, Option, Redacted } from "effect"
import type { EngineError, Project } from "@matisa/core"
import type { EnvRepoShape } from "@matisa/store"
import { toEngineError } from "../../shared/error-map.js"
import type { KeychainShape } from "./providers/catalog.providers.keychain.types.js"

// ────────────────────────────────────────────────────────────────────────────
// Effective-env resolution: the project's active context is layered into a flat
// child env, resolving secret refs through the Keychain into plaintext. This is
// the ONLY place secret values are read; the result is fed straight to the child
// process env and never logged.
// ────────────────────────────────────────────────────────────────────────────

export interface EnvResolveDeps {
  readonly envRepo: EnvRepoShape
  readonly keychain: KeychainShape
}

export const resolveEnv = (
  project: Project,
  deps: EnvResolveDeps
): Effect.Effect<Record<string, string>, EngineError> =>
  Effect.gen(function* () {
    const ctxId = project.activeContextId
    if (ctxId === undefined) return {}

    const contexts = yield* deps.envRepo.list().pipe(Effect.mapError(toEngineError))
    const ctx = contexts.find((c) => c.id === ctxId)
    if (ctx === undefined) return {}

    const out: Record<string, string> = {}
    for (const v of ctx.vars) {
      if (v.kind === "plain") {
        out[v.key] = v.value
      } else {
        const resolved = yield* deps.keychain.get(v.secretRef).pipe(Effect.mapError(toEngineError))
        if (Option.isSome(resolved)) out[v.key] = Redacted.value(resolved.value)
      }
    }
    return out
  })
