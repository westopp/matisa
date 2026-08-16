import { Context, Effect, Layer } from "effect"
import { and, eq, gt, lte, max } from "drizzle-orm"
import { ProjectId, type EngineEvent } from "@matisa/core"
import { events, type EventRow } from "../db.schema/db.events.js"
import { Store } from "../store.client.js"
import { StoreQueryError } from "../store.errors.js"

/** An event to append — the full EngineEvent minus its DB-assigned `seq`.
 *  Distributed over the union deliberately: a bare `Omit<EngineEvent, "seq">`
 *  collapses to the keys every member shares, which since config_changed joined
 *  no longer includes `projectId` — every builder would lose the field. */
export type NewEvent = EngineEvent extends infer E
  ? E extends EngineEvent
    ? Omit<E, "seq">
    : never
  : never

export interface EventPullParams {
  /** Return events with seq strictly greater than this cursor. */
  readonly since: number
  readonly limit?: number
  readonly projectId?: ProjectId
}

export interface EventPullResult {
  readonly events: ReadonlyArray<EngineEvent>
  readonly nextCursor: number
}

// ────────────────────────────────────────────────────────────────────────────
// EventsRepo — the ONLY writer of the events table (durable-cursor-events).
// `append` returns the new autoincrement seq (the cursor); `pull` replays by
// cursor for one-shot backfill; live fan-out is a PubSub push built above this.
//
// Single-table, flat rows — no aggregate assembly — so this repo goes through
// the schema-aware Drizzle client and takes its row type from the schema
// (`EventRow` = typeof events.$inferSelect) instead of a hand-synced interface.
// ────────────────────────────────────────────────────────────────────────────

export interface EventsRepoShape {
  readonly append: (event: NewEvent) => Effect.Effect<number, StoreQueryError>
  readonly pull: (params: EventPullParams) => Effect.Effect<EventPullResult, StoreQueryError>
  readonly latestCursor: () => Effect.Effect<number, StoreQueryError>
  /** Last N log_line payloads for a project, oldest→newest (logs.tail). */
  /** Retention: delete everything older than the newest `keepLast` events.
   * Returns rows deleted. Cursors < the new floor become unpullable — clients
   * resuming from a pruned cursor simply start at the floor. */
  readonly prune: (keepLast: number) => Effect.Effect<number, StoreQueryError>
}

export class EventsRepo extends Context.Tag("EventsRepo")<EventsRepo, EventsRepoShape>() {}

// A NULL project_id is the unscoped envelope (config_changed), so the field is
// omitted rather than emitted as undefined — the union's unscoped branch does
// not declare it, and a present-but-undefined key would decode as a malformed
// member of the scoped one.
const toEvent = (r: EventRow): EngineEvent =>
  ({
    seq: r.seq,
    ts: r.ts,
    ...(r.projectId === null ? {} : { projectId: ProjectId.make(r.projectId) }),
    type: r.type,
    payload: JSON.parse(r.payloadJson)
  }) as EngineEvent

export const EventsRepoLive = Layer.effect(
  EventsRepo,
  Effect.gen(function* () {
    const { db } = yield* Store

    const q = <A>(fn: () => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({ try: fn, catch: (cause) => new StoreQueryError({ cause }) })

    const append: EventsRepoShape["append"] = (event) =>
      q(() => {
        // RETURNING the PK beats reading lastInsertRowid — the cursor comes
        // straight from the insert rather than a second, racier round-trip.
        const row = db
          .insert(events)
          .values({
            ts: event.ts,
            projectId: "projectId" in event ? event.projectId : null,
            topic: null,
            type: event.type,
            payloadJson: JSON.stringify(event.payload)
          })
          .returning({ seq: events.seq })
          .get()
        return row.seq
      })

    const pull: EventsRepoShape["pull"] = (params) =>
      q(() => {
        const rows = db
          .select()
          .from(events)
          .where(
            and(
              gt(events.seq, params.since),
              params.projectId ? eq(events.projectId, params.projectId) : undefined
            )
          )
          .orderBy(events.seq)
          .limit(params.limit ?? 100)
          .all()
        const pulled = rows.map(toEvent)
        const nextCursor = pulled.at(-1)?.seq ?? params.since
        return { events: pulled, nextCursor }
      })

    const latestCursor: EventsRepoShape["latestCursor"] = () =>
      q(() => {
        const r = db.select({ m: max(events.seq) }).from(events).get()
        return r?.m ?? 0
      })

    const prune: EventsRepoShape["prune"] = (keepLast) =>
      q(() => {
        const top = db.select({ m: max(events.seq) }).from(events).get()?.m ?? 0
        const floor = top - keepLast
        if (floor <= 0) return 0
        const res = db.delete(events).where(lte(events.seq, floor)).run()
        return res.changes
      })

    return EventsRepo.of({ append, pull, latestCursor, prune })
  })
)
