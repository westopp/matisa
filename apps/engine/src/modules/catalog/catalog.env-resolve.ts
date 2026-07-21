import { Effect } from "effect"
import { BASE_CONTEXT_ID, type EngineError, type EnvContext, type Project } from "@matisa/core"
import type { EnvRepoShape } from "@matisa/store"
import { toEngineError } from "../../shared/error-map.js"

// ────────────────────────────────────────────────────────────────────────────
// Effective-env resolution, layered lowest→highest precedence:
//   1. `base` context — ALWAYS injected, active context or not
//   2. the project's active context — overrides / adds on key conflicts
// The flat result feeds straight into the spawn. POC: values (secrets
// included) come from the store; a keychain provider re-enters here post-POC.
// ────────────────────────────────────────────────────────────────────────────

export interface EnvResolveDeps {
  readonly envRepo: EnvRepoShape
}

const layer = (out: Record<string, string>, ctx: EnvContext | undefined): void => {
  if (ctx === undefined) return
  for (const v of ctx.vars) out[v.key] = v.value
}

export const resolveEnv = (
  project: Project,
  deps: EnvResolveDeps
): Effect.Effect<Record<string, string>, EngineError> =>
  Effect.gen(function* () {
    const contexts = yield* deps.envRepo.list().pipe(Effect.mapError(toEngineError))

    const out: Record<string, string> = {}
    layer(out, contexts.find((c) => (c.id as string) === BASE_CONTEXT_ID))
    if (project.activeContextId !== undefined) {
      layer(out, contexts.find((c) => c.id === project.activeContextId))
    }
    return out
  })
