import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PortConflict } from "@matisa/store"
import { toEngineError } from "../shared/error-map.js"
import { engineErrorToPayload, RPC_PORT_CONFLICT } from "../server/server.errors.js"

// The message a store fault carries is the one a client puts in front of the
// user verbatim — the desktop toasts `err.message`, the CLI prints it. A port
// conflict therefore has to name the project holding the port: the id it used
// to carry identified the holder without letting anyone recognise it.

describe("toEngineError — PortConflict", () => {
  it("names the holder in the message and keeps its id on the error", () => {
    const wire = toEngineError(
      new PortConflict({ port: 5200, heldBy: "p-123", heldByName: "Acme API" })
    )
    assert.equal(wire._tag, "PortConflict")
    assert.equal(wire.message, 'port 5200 is already claimed by "Acme API"')
    if (wire._tag === "PortConflict") assert.equal(wire.heldBy, "p-123")
  })

  it("falls back to the id when the holder has no name", () => {
    const wire = toEngineError(new PortConflict({ port: 5200, heldBy: "p-123" }))
    assert.equal(wire.message, 'port 5200 is already claimed by "p-123"')
  })

  it("says only what it knows when there is no holder at all", () => {
    const wire = toEngineError(new PortConflict({ port: 5200 }))
    assert.equal(wire.message, "port 5200 is already claimed")
  })

  it("reaches the client on the wire, message intact", () => {
    const payload = engineErrorToPayload(
      toEngineError(new PortConflict({ port: 5200, heldBy: "p-123", heldByName: "Acme API" }))
    )
    assert.equal(payload.code, RPC_PORT_CONFLICT)
    assert.equal(payload.message, 'port 5200 is already claimed by "Acme API"')
  })
})
