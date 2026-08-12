import type { ExposureLanSetParams } from "@matisa/core"
import type { ExposureShape } from "../../modules/exposure/exposure.index.js"
import type { Handlers } from "../server.dispatcher.js"

// exposure.* — stable URLs + LAN sharing. Derivation is engine-side; the only
// client-driven mutation is the LAN toggle.
export const exposureHandlers = (
  exposure: ExposureShape
): Pick<Handlers, "exposure.snapshot" | "exposure.lan.set"> => ({
  "exposure.snapshot": () => exposure.snapshot(),
  "exposure.lan.set": (params) => {
    const p = params as ExposureLanSetParams
    return exposure.lanSet(p.id, p.enabled)
  }
})
