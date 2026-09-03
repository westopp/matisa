import { Effect } from "effect"
import { NotFound, type ContextId, type EngineError, type EnvContext, type Project } from "@matisa/core"
import type { EnvRepoShape } from "@matisa/store"
import { toEngineError } from "../../shared/error-map.js"

// ────────────────────────────────────────────────────────────────────────────
// Effective-env resolution, layered lowest→highest precedence:
//   1. the PROJECT'S base context — always injected, active context or not
//   2. the project's active context — overrides / adds on key conflicts,
//      unless this spawn was given a one-off context to use instead
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

/** This project's contexts, and only ever this project's. */
const mineOf = (
  project: Project,
  deps: EnvResolveDeps
): Effect.Effect<ReadonlyArray<EnvContext>, EngineError> =>
  deps.envRepo
    .list()
    .pipe(
      Effect.mapError(toEngineError),
      Effect.map((all) => all.filter((c) => c.projectId === project.id))
    )

/** A user-supplied context ref → the id of one of this project's contexts.
 *
 *  Takes an id or a name, matched case-insensitively, because a name is unique
 *  within a project and a project is exactly the scope a caller of this already
 *  has. The project's base is nameable too: `--context base` is how a caller
 *  says "no overlay", which the stored selection has no way to express.
 *
 *  Fails rather than falling back. A caller that asked for `staging` and
 *  silently got the stored selection would run the wrong environment and be
 *  told nothing — the one outcome this whole feature exists to prevent. The
 *  refusal lists what the project does have, because a typo and a context that
 *  was never created are the same mistake from the caller's side. */
export const resolveContextRef = (
  project: Project,
  ref: string,
  deps: EnvResolveDeps
): Effect.Effect<ContextId, EngineError> =>
  Effect.gen(function* () {
    const mine = yield* mineOf(project, deps)
    const wanted = ref.trim().toLowerCase()
    const hit = mine.find(
      (c) => (c.id as string).toLowerCase() === wanted || c.name.toLowerCase() === wanted
    )
    if (hit !== undefined) return hit.id
    const available = mine.map((c) => c.name).join(", ")
    return yield* Effect.fail(
      new NotFound({
        entity: "context",
        id: ref,
        message:
          `${project.name} has no environment "${ref}"` +
          (available.length > 0 ? ` — it has: ${available}` : " — it has none but its base")
      })
    )
  })

/** The environment a spawn runs with.
 *
 *  `contextId` is a one-off override for THIS spawn: it replaces the project's
 *  stored `activeContextId` without changing it. Pass the project's own base id
 *  to run with base alone. Validate the ref with `resolveContextRef` before
 *  getting here — callers wrap this in a catch-all so a store hiccup degrades
 *  to an empty env rather than failing a start, and a bad ref must not be
 *  swallowed by that. */
export const resolveEnv = (
  project: Project,
  deps: EnvResolveDeps,
  contextId?: ContextId
): Effect.Effect<Record<string, string>, EngineError> =>
  Effect.gen(function* () {
    // Narrowed before anything is read: resolution cannot reach across projects
    // even if activeContextId were somehow stale, because the candidates are
    // only ever this project's own contexts.
    const mine = yield* mineOf(project, deps)

    const out: Record<string, string> = {}
    layer(out, mine.find((c) => c.isBase))
    const selected = contextId ?? project.activeContextId
    if (selected !== undefined) {
      layer(
        out,
        mine.find((c) => c.id === selected && !c.isBase)
      )
    }
    return out
  })
