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
import {
  DockerDaemonRequired,
  PortBusy,
  type Accepted,
  type EngineError,
  type Health,
  type ProjectId,
  type RuntimeStatus
} from "@matisa/core"
import { EnvRepo, ProjectsRepo, RuntimeRepo } from "@matisa/store"
import { AppConfig } from "../../config/config.app-config.js"
import { EventsHub } from "../../server/server.events-hub.js"
import { stateChanged } from "../../shared/events.js"
import { toEngineError } from "../../shared/error-map.js"
import { DockerDaemon } from "../docker/docker.daemon.js"
import { PtyManager } from "../pty/pty.services.js"
import { hardKill } from "./supervisor.kill.js"
import { foreignListener } from "./supervisor.probe.js"
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
  /** Force down, no drain and no waiting. See supervisor.kill.ts. */
  readonly kill: (id: ProjectId) => Effect.Effect<Accepted, EngineError>
  /** Acknowledge a terminal failure: `crashed`/`errored` → `idle`, and nothing
   *  else. No signal, no runner, no process on either side of it. */
  readonly reset: (id: ProjectId) => Effect.Effect<Accepted, EngineError>
  readonly status: (id: ProjectId) => Effect.Effect<RuntimeStatus, EngineError>
}

export class Supervisor extends Context.Tag("Supervisor")<Supervisor, SupervisorShape>() {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectsRepo
  const runtimeRepo = yield* RuntimeRepo
  const envRepo = yield* EnvRepo
  const events = yield* EventsHub
  const config = yield* AppConfig
  const ptyMgr = yield* PtyManager
  const daemon = yield* DockerDaemon
  const scope = yield* Effect.scope
  const rt = yield* Effect.runtime<never>()

  const runners = yield* SynchronizedRef.make(
    HashMap.empty<string, Fiber.RuntimeFiber<void, never>>()
  )

  const deps: RunnerDeps = { runtimeRepo, envRepo, events, config, pty: ptyMgr, rt }

  const start: SupervisorShape["start"] = (id) =>
    Effect.gen(function* () {
      const project = yield* projects.get(id).pipe(Effect.mapError(toEngineError))

      // A start on an already-running project replaces its runner cleanly.
      const map = yield* SynchronizedRef.get(runners)
      const stale = HashMap.get(map, id as string)
      if (Option.isSome(stale)) yield* Fiber.interrupt(stale.value)

      if (project.kind === "docker" || project.kind === "compose") {
        // Daemon gating (old-app parity): typed error, client prompts the
        // user, calls docker.daemon.start on consent, then replays this.
        const up = yield* daemon.probe()
        if (!up) {
          return yield* Effect.fail(
            new DockerDaemonRequired({
              action: "start",
              projectId: id,
              message: `Docker daemon is not running — cannot start ${project.name}. Start Docker (docker.daemon.start) and retry.`
            })
          )
        }
      } else {
        // Foreign-listener guard: the user always knows who holds the port.
        for (const p of project.ports) {
          const holder = yield* foreignListener(p.number)
          if (holder !== undefined) {
            const message = `port ${p.number} is already in use by ${holder.processName ?? "an unknown process"}${holder.pid !== undefined ? ` (pid ${holder.pid})` : ""} — not managed by matisa`
            // Refused before any runner exists, so this is the only chance to
            // write it down. Without the record the refusal lived in one toast:
            // dismiss it and nothing anywhere said why the start did nothing.
            yield* runtimeRepo
              .recordCrash({ projectId: id, kind: "error", summary: message })
              .pipe(Effect.ignore)
            return yield* Effect.fail(
              new PortBusy({
                port: p.number,
                pid: holder.pid,
                processName: holder.processName,
                message
              })
            )
          }
        }
      }

      const fiber = yield* runProject(project, deps).pipe(
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            const reason = Cause.pretty(cause)
            yield* runtimeRepo.setState(id, { state: "errored" }).pipe(Effect.ignore)
            yield* runtimeRepo
              .recordCrash({ projectId: id, kind: "error", summary: reason })
              .pipe(Effect.ignore)
            yield* events.emit(stateChanged(id, "starting", "errored", reason))
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
        // Publish it, don't just persist it. `Fiber.interrupt` below blocks
        // until the child is reaped — SIGTERM, the app's own drain, then the
        // 8s SIGKILL backstop. That is seconds of real work, and without this
        // emit the only event a client ever sees is the terminal `idle`, so
        // teardown looks instantaneous and every stop button is dead in the
        // interim. State is event-derived truth (state-is-truth) — a state
        // written to the DB but never published is not observable.
        yield* events.emit(stateChanged(id, "running", "stopping", "stop requested"))
        yield* Fiber.interrupt(existing.value)
        yield* SynchronizedRef.update(runners, HashMap.remove(id as string))
      }
      yield* runtimeRepo.setState(id, { state: "idle" }).pipe(Effect.ignore)
      yield* events.emit(stateChanged(id, "stopping", "idle", "stopped"))
      return { id, state: "idle" as const }
    })

  const restart: SupervisorShape["restart"] = (id) => stop(id).pipe(Effect.flatMap(() => start(id)))

  // The whole point is that this returns. `stop` awaits `Fiber.interrupt`,
  // which runs the runner's finalizers — the graceful teardown, the drain, the
  // wait — and that wait is exactly what strands a project in `stopping`. Here
  // the child is killed FIRST, so by the time the runner is interrupted its
  // finalizer finds a corpse and completes immediately; `interruptFork` then
  // declines to wait even for that. Nothing between the click and `idle` can
  // block.
  const kill: SupervisorShape["kill"] = (id) =>
    Effect.gen(function* () {
      const project = yield* projects.get(id).pipe(Effect.mapError(toEngineError))
      const persisted = yield* runtimeRepo.getState(id).pipe(Effect.mapError(toEngineError))
      const before = Option.getOrUndefined(persisted)

      yield* hardKill(project, before?.pid)

      const map = yield* SynchronizedRef.get(runners)
      const existing = HashMap.get(map, id as string)
      if (Option.isSome(existing)) {
        yield* Fiber.interruptFork(existing.value)
        yield* SynchronizedRef.update(runners, HashMap.remove(id as string))
      }

      // `idle`, not `crashed`: the process did not fail, it was ended on
      // purpose. A kill that reported a crash would fill the Failures tab with
      // the user's own decisions.
      yield* runtimeRepo.setState(id, { state: "idle" }).pipe(Effect.ignore)
      yield* events.emit(stateChanged(id, before?.state ?? "running", "idle", "killed"))
      return { id, state: "idle" as const }
    })

  // Dismissal, not lifecycle. The FSM says which states it is legal from
  // (Crashed/Errored only — see supervisor.machine.ts); everything else is a
  // no-op that reports back what the project is actually doing, so a click on a
  // stale card can never talk a live project into `idle`.
  const reset: SupervisorShape["reset"] = (id) =>
    Effect.gen(function* () {
      const persisted = yield* runtimeRepo.getState(id).pipe(Effect.mapError(toEngineError))
      const before = Option.getOrUndefined(persisted)?.state ?? "idle"
      if (before !== "crashed" && before !== "errored") return { id, state: before }

      yield* runtimeRepo.setState(id, { state: "idle" }).pipe(Effect.ignore)
      yield* events.emit(stateChanged(id, before, "idle", "failure acknowledged"))
      return { id, state: "idle" as const }
    })

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
            sessionId: s.sessionId,
            health: s.health as Health | undefined
          })
        })
      )
    )

  return Supervisor.of({ start, stop, restart, kill, reset, status })
})

export const SupervisorLive = Layer.scoped(Supervisor, make)
