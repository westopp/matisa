import { Effect } from "effect"
import type {
  BySessionId,
  PtyInputParams,
  PtyOpenParams,
  PtyResizeParams
} from "@matisa/core"
import type { PtyManagerShape } from "../../modules/pty/pty.services.js"
import { bridgeSessionToConnection } from "../server.pty-bridge.js"
import type { Handlers } from "../server.dispatcher.js"

// pty.open/attach/input/resize → the PtyManager. `open` creates the session AND
// bridges it onto the opening connection (the CLI starts reading pty.output
// immediately after the response — it never sends a separate attach). `attach`
// bridges an existing session (run:<projectId> for the supervised process, or a
// sh:* shell). Bridged pumps live on the connection scope: disconnect detaches.

export const ptyHandlers = (
  pty: PtyManagerShape
): Pick<Handlers, "pty.open" | "pty.attach" | "pty.input" | "pty.resize"> => ({
  "pty.open": (params, conn) =>
    Effect.gen(function* () {
      const session = yield* pty.open(params as PtyOpenParams)
      yield* bridgeSessionToConnection(pty, session.sessionId, conn)
      return session
    }),
  "pty.attach": (params, conn) =>
    bridgeSessionToConnection(pty, (params as BySessionId).sessionId, conn),
  "pty.input": (params) => pty.input(params as PtyInputParams),
  "pty.resize": (params) => pty.resize(params as PtyResizeParams)
})
