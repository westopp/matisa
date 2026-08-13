import { Data, Option } from "effect"
import type { RuntimeState } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// Pure supervisor FSM (state-is-truth tenet). State and Event are Data.TaggedEnum;
// `transition` is total, pure, and Effect-free — trivially unit-tested. Illegal
// (state, event) pairs return Option.none() and are ignored by the runner. Runtime
// state truth is derived from real process events fed into this machine, never
// from kill(pid, 0) polling.
// ────────────────────────────────────────────────────────────────────────────

export type State = Data.TaggedEnum<{
  Idle: {}
  Starting: { readonly attempt: number }
  Running: { readonly pid: number; readonly since: number }
  Stopping: {}
  Crashed: { readonly code: number | null; readonly signal: string | null }
  Errored: { readonly reason: string }
  Unmanaged: { readonly pid: number }
}>
export const State = Data.taggedEnum<State>()

export type Event = Data.TaggedEnum<{
  Start: { readonly attempt: number }
  Stop: {}
  Kill: {}
  Healthy: { readonly pid: number; readonly since: number }
  Fault: { readonly reason: string }
  Exit: { readonly code: number | null; readonly signal: string | null }
  Timeout: {}
  ForeignListener: { readonly pid: number }
  /** The foreign holder is gone — discovery swept and found nothing on the
   *  project's port. The counterpart to ForeignListener, and the ONLY way out
   *  of Unmanaged that is not a Start: `unmanaged` is an observation, so only a
   *  fresh observation may retract it. */
  Released: {}
  /** Acknowledge a terminal failure. The user has read why it died and wants
   *  the project back at rest — a dismissal, not a lifecycle action: there is
   *  no process on either side of it. Legal ONLY from Crashed/Errored, so it
   *  can never dismiss a state that describes something still alive. */
  Reset: {}
}>
export const Event = Data.taggedEnum<Event>()

const isCleanExit = (code: number | null, signal: string | null): boolean =>
  code === 0 && signal === null

/** Total, pure transition. Returns none() for illegal pairs. */
export const transition = (state: State, event: Event): Option.Option<State> => {
  switch (state._tag) {
    case "Idle":
      if (event._tag === "Start") return Option.some(State.Starting({ attempt: event.attempt }))
      if (event._tag === "ForeignListener") return Option.some(State.Unmanaged({ pid: event.pid }))
      return Option.none()

    case "Starting":
      switch (event._tag) {
        case "Healthy":
          return Option.some(State.Running({ pid: event.pid, since: event.since }))
        case "Exit":
          return Option.some(
            isCleanExit(event.code, event.signal)
              ? State.Idle()
              : State.Crashed({ code: event.code, signal: event.signal })
          )
        case "Timeout":
          return Option.some(State.Errored({ reason: "start timeout" }))
        case "Stop":
        case "Kill":
          return Option.some(State.Stopping())
        case "Fault":
          return Option.some(State.Errored({ reason: event.reason }))
        default:
          return Option.none()
      }

    case "Running":
      switch (event._tag) {
        case "Exit":
          return Option.some(
            isCleanExit(event.code, event.signal)
              ? State.Idle()
              : State.Crashed({ code: event.code, signal: event.signal })
          )
        case "Stop":
        case "Kill":
          return Option.some(State.Stopping())
        case "Fault":
          return Option.some(State.Errored({ reason: event.reason }))
        default:
          return Option.none()
      }

    case "Stopping":
      switch (event._tag) {
        case "Exit":
        case "Timeout":
          return Option.some(State.Idle())
        default:
          return Option.none()
      }

    case "Crashed":
    case "Errored":
      if (event._tag === "Start") return Option.some(State.Starting({ attempt: event.attempt }))
      if (event._tag === "Fault") return Option.some(State.Errored({ reason: event.reason }))
      if (event._tag === "Reset") return Option.some(State.Idle())
      return Option.none()

    // Reset is deliberately NOT legal here: `unmanaged` says a process this
    // engine does not own holds the port. Clearing it to idle would be the UI
    // asserting something it has not checked and cannot change.
    case "Unmanaged":
      if (event._tag === "Start") return Option.some(State.Starting({ attempt: event.attempt }))
      if (event._tag === "Fault") return Option.some(State.Errored({ reason: event.reason }))
      if (event._tag === "Released") return Option.some(State.Idle())
      return Option.none()
  }
}

/** Project the FSM state onto the wire RuntimeState literal. */
export const runtimeStateOf = (state: State): RuntimeState => {
  switch (state._tag) {
    case "Idle":
      return "idle"
    case "Starting":
      return "starting"
    case "Running":
      return "running"
    case "Stopping":
      return "stopping"
    case "Crashed":
      return "crashed"
    case "Errored":
      return "errored"
    case "Unmanaged":
      return "unmanaged"
  }
}
