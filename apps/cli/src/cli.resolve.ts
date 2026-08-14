import { Data, Effect, Option } from "effect"
import { ProjectId } from "@matisa/core"
import { call, NotFound } from "./transport/transport.index.js"
import type { EngineClient } from "./transport/transport.index.js"
import type { TransportError } from "./transport/transport.index.js"

// ────────────────────────────────────────────────────────────────────────────
// Project tokens — what a human types where the wire wants an id.
//
// Project ids are uuids the engine mints. Every command took one verbatim,
// which made the CLI unusable by hand: `matisa restart web` was the obvious
// thing to type and the only correct form was a uuid nobody can remember, so
// every session began with `matisa project list` and a copy-paste. The desktop
// never had this problem — it shows names and holds the ids.
//
// So a token is either. A uuid goes straight through untouched (scripts keep
// their single round-trip, and the engine stays the authority on whether it
// exists); anything else is looked up by name against the catalog, matched
// case-insensitively because shells and humans do not agree about case.
//
// Ambiguity is refused, not guessed. Two projects may legitimately share a
// name — nothing in the catalog forbids it — and picking one would silently
// act on the wrong project. The refusal names both so the user can retype with
// the id.
// ────────────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A name matched more than one project. Usage error, not a wire failure. */
export class AmbiguousProject extends Data.TaggedError("AmbiguousProject")<{
  readonly token: string
  readonly matches: ReadonlyArray<{ readonly id: string; readonly name: string }>
}> {}

export interface Named {
  readonly id: string
  readonly name: string
}

export type Match =
  | { readonly _tag: "id"; readonly id: string }
  | { readonly _tag: "one"; readonly id: string }
  | { readonly _tag: "many"; readonly matches: ReadonlyArray<Named> }
  | { readonly _tag: "none" }

/** The whole rule, with no engine attached — a token and a catalog in, a verdict
 *  out. Split out because this is the part worth testing: the round-trip is
 *  plumbing, but "which project did they mean" is a decision. */
export const matchProject = (projects: ReadonlyArray<Named>, token: string): Match => {
  if (UUID.test(token)) return { _tag: "id", id: token }
  const wanted = token.toLowerCase()
  const matches = projects.filter((p) => p.name.toLowerCase() === wanted)
  if (matches.length === 1) return { _tag: "one", id: matches[0]!.id }
  if (matches.length > 1) return { _tag: "many", matches }
  return { _tag: "none" }
}

/** Turn a user-supplied token into a project id. */
export const resolveProject = (
  token: string
): Effect.Effect<ProjectId, TransportError | AmbiguousProject, EngineClient> =>
  Effect.gen(function* () {
    // A uuid never costs a catalog read: scripts that already hold ids keep
    // their single round-trip, and the engine stays the authority on whether
    // the id exists.
    if (UUID.test(token)) return ProjectId.make(token)

    const projects = yield* call("catalog.list", undefined)
    const verdict = matchProject(projects, token)
    switch (verdict._tag) {
      case "id":
      case "one":
        return ProjectId.make(verdict.id)
      case "many":
        return yield* Effect.fail(new AmbiguousProject({ token, matches: verdict.matches }))
      case "none":
        return yield* Effect.fail(
          new NotFound({
            entity: "project",
            id: token,
            message: `no project with that id or name (${projects.length} in the catalog)`
          })
        )
    }
  })

/** The same, for the commands whose project argument is optional — `undefined`
 *  stays `undefined` rather than becoming a lookup of the empty string. */
export const resolveOptional = (
  token: Option.Option<string>
): Effect.Effect<ProjectId | undefined, TransportError | AmbiguousProject, EngineClient> =>
  Option.isNone(token) ? Effect.succeed(undefined) : resolveProject(token.value)
