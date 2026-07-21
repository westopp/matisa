import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { GroupSlug, type Group } from "@matisa/core"
import { groups, type GroupRow } from "../db.schema/db.groups.js"
import { Store } from "../store.client.js"
import { StoreQueryError } from "../store.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// GroupsRepo — standalone organizational buckets. Single flat table, so it
// rides the schema-aware Drizzle client ($inferSelect row type). Deleting a
// group leaves member projects intact (FK ON DELETE SET NULL).
// ────────────────────────────────────────────────────────────────────────────

export interface GroupsRepoShape {
  readonly set: (group: Group) => Effect.Effect<Group, StoreQueryError>
  readonly list: () => Effect.Effect<ReadonlyArray<Group>, StoreQueryError>
  readonly remove: (slug: GroupSlug) => Effect.Effect<void, StoreQueryError>
}

export class GroupsRepo extends Context.Tag("GroupsRepo")<GroupsRepo, GroupsRepoShape>() {}

const toGroup = (r: GroupRow): Group => ({
  slug: GroupSlug.make(r.slug),
  title: r.title,
  description: r.description ?? undefined,
  notes: r.notes ?? undefined,
  pathToIcon: r.pathToIcon ?? undefined
})

export const GroupsRepoLive = Layer.effect(
  GroupsRepo,
  Effect.gen(function* () {
    const { db } = yield* Store

    const q = <A>(fn: () => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({ try: fn, catch: (cause) => new StoreQueryError({ cause }) })

    const set: GroupsRepoShape["set"] = (group) =>
      q(() => {
        const row = {
          slug: group.slug as string,
          title: group.title,
          description: group.description ?? null,
          notes: group.notes ?? null,
          pathToIcon: group.pathToIcon ?? null
        }
        db.insert(groups)
          .values(row)
          .onConflictDoUpdate({ target: groups.slug, set: row })
          .run()
        return group
      })

    const list: GroupsRepoShape["list"] = () =>
      q(() => db.select().from(groups).orderBy(groups.slug).all().map(toGroup))

    const remove: GroupsRepoShape["remove"] = (slug) =>
      q(() => {
        db.delete(groups).where(eq(groups.slug, slug as string)).run()
      })

    return GroupsRepo.of({ set, list, remove })
  })
)
