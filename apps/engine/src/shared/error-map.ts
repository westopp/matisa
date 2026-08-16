import {
  EngineInternal,
  NotFound,
  PortConflict,
  ProjectId,
  ValidationError,
  type EngineError
} from "@matisa/core"

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
    case "NameTaken": {
      const x = e as { entity: string; name: string }
      return new ValidationError({
        field: "name",
        message: `${x.entity === "env_context" ? "An environment" : x.entity} called "${x.name}" already exists`
      })
    }
    case "BaseContextImmutable": {
      const x = e as { action: "rename" | "remove" }
      return new ValidationError({
        field: x.action === "rename" ? "name" : "contextId",
        message: `A project's base environment cannot be ${x.action === "rename" ? "renamed" : "deleted"} — it is created and removed with the project itself`
      })
    }
    // Names the owner rather than just refusing: a client that picked a context
    // from a stale list needs to know the environment exists and belongs
    // elsewhere, which is a different fix from the id being wrong.
    case "ContextNotInProject": {
      const x = e as { contextId: string; ownerId: string }
      return new ValidationError({
        field: "contextId",
        message: `Environment '${x.contextId}' belongs to a different project (${x.ownerId}) — a project can only use its own environments`
      })
    }
    case "PortConflict": {
      const x = e as { port: number; heldBy?: string; heldByName?: string }
      // The sentence names the holder; the id stays on the error for clients
      // that want to navigate to it. A uuid in the message told the user only
      // that the conflict was with something.
      const holder = x.heldByName ?? x.heldBy
      return new PortConflict({
        port: x.port,
        heldBy: x.heldBy != null ? ProjectId.make(x.heldBy) : undefined,
        message: `port ${x.port} is already claimed${holder != null ? ` by "${holder}"` : ""}`
      })
    }
    default:
      return new EngineInternal({ message: describe(e), cause: describe(e) })
  }
}
