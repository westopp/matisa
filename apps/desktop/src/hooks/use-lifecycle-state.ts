import type { ProjectWithState } from "@matisa/core"
import { useEngine, type Intent } from "~/store/store.engine"

// ────────────────────────────────────────────────────────────────────────────
// One answer to "what is this project doing right now", shared by every
// surface that draws a start/stop control. Kept in one place so the hero and
// the sidebar can never disagree about whether a project is busy.
//
// Busy comes from two sources, in order:
//   1. optimistic — the user clicked and the RPC is still on the wire
//   2. engine-reported — the FSM is in `starting` or `stopping`
//
// Readiness is NOT one of them. A worker with no declared port never becomes
// `ready`, so gating on it would leave that project loading forever.
// ────────────────────────────────────────────────────────────────────────────

export interface LifecycleState {
  /** A transition is in progress; controls should be disabled. */
  readonly busy: boolean
  /** What is happening, for the button label. */
  readonly intent: Intent | null
  /** The project is up as far as the kernel is concerned. */
  readonly running: boolean
  /** Up, but the declared port has not accepted a connection yet. Presentation
   *  only — never a reason to disable a control. */
  readonly warmingUp: boolean
}

export const useLifecycleState = (project: ProjectWithState): LifecycleState => {
  const optimistic = useEngine((s) => s.pending[project.id])

  const fromState: Intent | null =
    project.state === "starting" ? "starting" : project.state === "stopping" ? "stopping" : null

  // The optimistic intent wins while set: during a restart the engine reports
  // `stopping` then `starting`, but the user asked for a restart and the label
  // should say so throughout.
  const intent = optimistic ?? fromState

  return {
    busy: intent !== null,
    intent,
    running: project.state === "running",
    warmingUp: project.state === "running" && project.health === "waiting"
  }
}

export const intentLabel = (intent: Intent): string =>
  intent === "starting" ? "Starting…" : intent === "stopping" ? "Stopping…" : "Restarting…"
