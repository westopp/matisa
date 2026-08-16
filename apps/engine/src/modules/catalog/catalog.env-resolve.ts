import { Effect } from "effect"
import type { EngineError, EnvContext, Project } from "@matisa/core"
import type { EnvRepoShape } from "@matisa/store"
import { toEngineError } from "../../shared/error-map.js"

// ────────────────────────────────────────────────────────────────────────────
// Effective-env resolution, layered lowest→highest precedence:
//   1. the PROJECT'S base context — always injected, active context or not
//   2. the project's active context — overrides / adds on key conflicts
// Both layers belong to this project: nothing another project can edit reaches
// this spawn. (There used to be a third possibility — one global `base` shared
// by every project — and it is gone; see migration 0006.)
// The flat result feeds straight into the spawn. POC: values (secrets included)
// come from the store; a keychain provider re-enters here post-POC.
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
    const all = yield* deps.envRepo.list().pipe(Effect.mapError(toEngineError))
    // Narrowed before anything is read: resolution cannot reach across projects
    // even if activeContextId were somehow stale, because the candidates are
    // only ever this project's own contexts.
    const mine = all.filter((c) => c.projectId === project.id)

    const out: Record<string, string> = {}
    layer(out, mine.find((c) => c.isBase))
    if (project.activeContextId !== undefined) {
      layer(
        out,
        mine.find((c) => c.id === project.activeContextId && !c.isBase)
      )
    }
    return out
  })
