import { EngineInternal, NotFound, PortConflict, ProjectId, type EngineError } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// Boundary mapping: store/provider Data.TaggedError faults → the four wire
// errors in @matisa/core. Services surface only EngineError so the dispatcher
// stays uniform (contracts-single-source). A store PortConflict becomes a core
// PortConflict, a store NotFound a core NotFound; everything else is folded into
// EngineInternal.
// ────────────────────────────────────────────────────────────────────────────

const describe = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === "object" && e !== null) {
    const anyE = e as Record<string, unknown>
    if (typeof anyE["message"] === "string") return anyE["message"]
  }
  return String(e)
}

export const toEngineError = (e: unknown): EngineError => {
  const tag = typeof e === "object" && e !== null ? (e as { _tag?: unknown })._tag : undefined
  switch (tag) {
    case "NotFound": {
      const x = e as { entity: string; id: string }
      return new NotFound({ entity: x.entity, id: x.id, message: `${x.entity} '${x.id}' not found` })
    }
    case "PortConflict": {
      const x = e as { port: number; heldBy?: string }
      return new PortConflict({
        port: x.port,
        heldBy: x.heldBy != null ? ProjectId.make(x.heldBy) : undefined,
        message: `port ${x.port} is already claimed${x.heldBy != null ? ` by ${x.heldBy}` : ""}`
      })
    }
    default:
      return new EngineInternal({ message: describe(e), cause: describe(e) })
  }
}
