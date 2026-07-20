import { Effect, Scope } from "effect"
import type { PullParams, SubscribeParams } from "@matisa/core"
import type { EventsHubShape } from "../server.events-hub.js"
import type { Handlers } from "../server.dispatcher.js"
import { EVENTS_NOTIFY } from "../server.schemas.js"

// events.subscribe/pull → the EventsHub. `pull` drains the durable table by
// cursor; `subscribe` wires live push onto the CONNECTION's scope so a disconnect
// tears the subscription down (durable-cursor-events).

export const eventsHandlers = (
  hub: EventsHubShape
): Pick<Handlers, "events.subscribe" | "events.pull"> => ({
  "events.pull": (params) => hub.pull(params as PullParams),
  "events.subscribe": (params, conn) =>
    Effect.gen(function* () {
      const opts = params as SubscribeParams
      const result = yield* hub
        .subscribe((event) => conn.notify(EVENTS_NOTIFY, event), { projectId: opts.projectId })
        .pipe(Effect.provideService(Scope.Scope, conn.scope))
      return { subscriptionId: result.subscriptionId, cursor: result.cursor }
    })
})
