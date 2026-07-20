import { Effect, Schema, Stream } from "effect"
import { EngineEvent, ProjectId } from "@matisa/core"
import type { EngineEvent as EngineEventType } from "@matisa/core"
import { EngineClient, nextRpcId } from "./transport.client.js"
import { call } from "./transport.control.js"
import type { TransportError } from "./transport.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// transport.events — both transport paths of the durable event queue.
//
//  • subscribe(): holds the connection and yields a live Stream of decoded
//    EngineEvents (the push path, for `watch`). Frames that are not events
//    (e.g. the subscribe ack) are dropped.
//  • pull(cursor): a one-shot drain of events.pull from a cursor, returning the
//    batch plus the next cursor to persist (the scriptable, resumable path).
// ────────────────────────────────────────────────────────────────────────────

const decodeEvent = Schema.decodeUnknownOption(EngineEvent)

export const subscribe = (
  projectId?: string
): Stream.Stream<EngineEventType, TransportError, EngineClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* EngineClient
      const params =
        projectId === undefined ? {} : { projectId: ProjectId.make(projectId) }
      return client
        .stream({
          jsonrpc: "2.0",
          id: nextRpcId(),
          method: "events.subscribe",
          params
        })
        .pipe(Stream.filterMap((frame) => decodeEvent(frame)))
    })
  )

export interface PullBatch {
  readonly events: ReadonlyArray<EngineEventType>
  readonly next: number
}

export const pull = (
  since: number,
  limit = 512,
  projectId?: string
): Effect.Effect<PullBatch, TransportError, EngineClient> =>
  call("events.pull", {
    since,
    limit,
    ...(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) })
  }).pipe(Effect.map((r) => ({ events: r.events, next: r.nextCursor })))
