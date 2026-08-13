import type { ByRef, DiscoverySnapshotParams } from "@matisa/core"
import type { DiscoveryShape } from "../../modules/discovery/discovery.index.js"
import type { Handlers } from "../server.dispatcher.js"

// discovery.* → the Discovery service. Read the machine, then act on one of the
// things it found. Nothing here adopts anything into the catalog: stopping a
// stranger's container is a favour to the user, not a claim of ownership.

export const discoveryHandlers = (
  discovery: DiscoveryShape
): Pick<Handlers, "discovery.snapshot" | "discovery.stop" | "discovery.start"> => ({
  "discovery.snapshot": (params) => discovery.snapshot((params as DiscoverySnapshotParams).refresh),
  "discovery.stop": (params) => discovery.stop((params as ByRef).ref),
  "discovery.start": (params) => discovery.start((params as ByRef).ref)
})
