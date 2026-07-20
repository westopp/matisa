import { Context, Effect, Layer, PubSub, Queue, Scope } from "effect"
import { randomUUID } from "node:crypto"
import type { EngineEvent, ProjectId } from "@matisa/core"
import { EventsRepo, type EventPullParams, type EventPullResult, type NewEvent } from "@matisa/store"

// ────────────────────────────────────────────────────────────────────────────
// EventsHub — push + pull over one durable queue (durable-cursor-events tenet).
//
//   emit      : append to the sqlite `events` table (durable, assigns seq), then
//               publish to a PubSub for live fan-out. Returns the new cursor.
//   pull      : one-shot backfill by cursor straight from the table.
//   subscribe : live stream. Forks a take→push loop onto the CALLER's Scope
//               (the connection scope), so a disconnect unsubscribes for free.
// ────────────────────────────────────────────────────────────────────────────

export interface SubscribeOptions {
  readonly projectId?: ProjectId
}

export interface EventsHubShape {
  readonly emit: (event: NewEvent) => Effect.Effect<number>
  readonly pull: (params: EventPullParams) => Effect.Effect<EventPullResult>
  readonly latestCursor: () => Effect.Effect<number>
  readonly subscribe: (
    push: (event: EngineEvent) => Effect.Effect<void>,
    options: SubscribeOptions
  ) => Effect.Effect<{ readonly subscriptionId: string; readonly cursor: number }, never, Scope.Scope>
}

export class EventsHub extends Context.Tag("EventsHub")<EventsHub, EventsHubShape>() {}

const make = Effect.gen(function* () {
  const repo = yield* EventsRepo
  const hub = yield* PubSub.unbounded<EngineEvent>()

  const emit: EventsHubShape["emit"] = (event) =>
    repo.append(event).pipe(
      Effect.flatMap((seq) =>
        PubSub.publish(hub, { ...event, seq } as EngineEvent).pipe(Effect.as(seq))
      ),
      // A durable-log write failure must never crash a supervisor/catalog caller.
      Effect.catchAll((cause) =>
        Effect.logError("events: append failed", cause).pipe(Effect.as(-1))
      )
    )

  const pull: EventsHubShape["pull"] = (params) =>
    repo.pull(params).pipe(
      Effect.catchAll(() => Effect.succeed({ events: [], nextCursor: params.since } satisfies EventPullResult))
    )

  const latestCursor: EventsHubShape["latestCursor"] = () =>
    repo.latestCursor().pipe(Effect.catchAll(() => Effect.succeed(0)))

  const subscribe: EventsHubShape["subscribe"] = (push, options) =>
    Effect.gen(function* () {
      const q = yield* PubSub.subscribe(hub)
      yield* Queue.take(q).pipe(
        Effect.flatMap((event) =>
          options.projectId === undefined || event.projectId === options.projectId
            ? push(event)
            : Effect.void
        ),
        Effect.forever,
        Effect.forkScoped
      )
      const cursor = yield* latestCursor()
      return { subscriptionId: randomUUID(), cursor }
    })

  return EventsHub.of({ emit, pull, latestCursor, subscribe })
})

export const EventsHubLive = Layer.effect(EventsHub, make)
