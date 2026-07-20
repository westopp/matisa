import {
  Cause,
  Context,
  Effect,
  Fiber,
  HashMap,
  Layer,
  Option,
  Runtime,
  SynchronizedRef
} from "effect"
import { type Accepted, type EngineError, type ProjectId, type RuntimeStatus } from "@matisa/core"
import { EnvRepo, ProjectsRepo, RuntimeRepo } from "@matisa/store"
import { AppConfig } from "../../config/config.app-config.js"
import { EventsHub } from "../../server/server.events-hub.js"
import { stateChanged } from "../../shared/events.js"
import { toEngineError } from "../../shared/error-map.js"
import { Keychain } from "../catalog/providers/catalog.providers.keychain.types.js"
import { PtyManager } from "../pty/pty.services.js"
import { runProject, type RunnerDeps } from "./supervisor.runner.js"

// ────────────────────────────────────────────────────────────────────────────
// Supervisor — start/stop/restart/status over a SynchronizedRef<HashMap<id,
// Fiber>>. `start` forks ONE supervised fiber per project (forkIn the layer scope)
// under catchAllCause, so a project failure is caught in-fiber and NEVER crashes
// the engine (crash-isolation). `stop` interrupts the fiber; Scope teardown kills
// the child. State reported by `status` is the persisted FSM truth.
// ────────────────────────────────────────────────────────────────────────────

export interface SupervisorShape {
  readonly start: (id: ProjectId) => Effect.Effect<Accepted, EngineError>
  readonly stop: (id: ProjectId) => Effect.Effect<Accepted, EngineError>
  readonly restart: (id: ProjectId) => Effect.Effect<Accepted, EngineError>
  readonly status: (id: ProjectId) => Effect.Effect<RuntimeStatus, EngineError>
}

export class Supervisor extends Context.Tag("Supervisor")<Supervisor, SupervisorShape>() {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectsRepo
  const runtimeRepo = yield* RuntimeRepo
  const envRepo = yield* EnvRepo
  const keychain = yield* Keychain
  const events = yield* EventsHub
  const config = yield* AppConfig
  const ptyMgr = yield* PtyManager
  const scope = yield* Effect.scope
  const rt = yield* Effect.runtime<never>()

  const runners = yield* SynchronizedRef.make(
    HashMap.empty<string, Fiber.RuntimeFiber<void, never>>()
  )

  const deps: RunnerDeps = { runtimeRepo, envRepo, keychain, events, config, pty: ptyMgr, rt }

  const start: SupervisorShape["start"] = (id) =>
    Effect.gen(function* () {
      const project = yield* projects.get(id).pipe(Effect.mapError(toEngineError))
      const fiber = yield* runProject(project, deps).pipe(
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* runtimeRepo.setState(id, { state: "errored" }).pipe(Effect.ignore)
            yield* events.emit(stateChanged(id, "starting", "errored", Cause.pretty(cause)))
          })
        ),
        Effect.forkIn(scope)
      )
      yield* SynchronizedRef.update(runners, HashMap.set(id as string, fiber))
      return { id, state: "starting" as const }
    })

  const stop: SupervisorShape["stop"] = (id) =>
    Effect.gen(function* () {
      const map = yield* SynchronizedRef.get(runners)
      const existing = HashMap.get(map, id as string)
      if (Option.isSome(existing)) {
        yield* runtimeRepo.setState(id, { state: "stopping" }).pipe(Effect.ignore)
        yield* Fiber.interrupt(existing.value)
        yield* SynchronizedRef.update(runners, HashMap.remove(id as string))
      }
      yield* runtimeRepo.setState(id, { state: "idle" }).pipe(Effect.ignore)
      yield* events.emit(stateChanged(id, "running", "idle", "stopped"))
      return { id, state: "idle" as const }
    })

  const restart: SupervisorShape["restart"] = (id) => stop(id).pipe(Effect.flatMap(() => start(id)))

  const status: SupervisorShape["status"] = (id) =>
    runtimeRepo.getState(id).pipe(
      Effect.mapError(toEngineError),
      Effect.map(
        Option.match({
          onNone: (): RuntimeStatus => ({ id, state: "idle" }),
          onSome: (s): RuntimeStatus => ({
            id,
            state: s.state,
            pid: s.pid,
            since: s.since,
            sessionId: s.sessionId
          })
        })
      )
    )

  return Supervisor.of({ start, stop, restart, status })
})

export const SupervisorLive = Layer.scoped(Supervisor, make)
