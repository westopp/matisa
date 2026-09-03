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
  ValidationError,
  type Accepted,
  type ContextId,
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
import { isUnder } from "../discovery/discovery.classify.js"
import { Discovery } from "../discovery/discovery.index.js"
import { workingDirs } from "../discovery/discovery.probes.js"
import { composeDownHard, inlineRemove } from "../docker/docker.actions.js"
import { DockerDaemon } from "../docker/docker.daemon.js"
import { PtyManager } from "../pty/pty.services.js"
import { hardKill } from "./supervisor.kill.js"
import { foreignListener } from "./supervisor.probe.js"
import { resolveContextRef } from "../catalog/catalog.env-resolve.js"
import { runProject, type RunnerDeps } from "./supervisor.runner.js"

// ────────────────────────────────────────────────────────────────────────────
// Supervisor — start/stop/restart/status over a SynchronizedRef<HashMap<id,
// Fiber>>. `start` forks ONE supervised fiber per project (forkIn the layer scope)
// under catchAllCause, so a project failure is caught in-fiber and NEVER crashes
// the engine (crash-isolation). `stop` interrupts the fiber; Scope teardown kills
// the child. State reported by `status` is the persisted FSM truth.
// ────────────────────────────────────────────────────────────────────────────

export interface SupervisorShape {
  /** `context` is an optional one-off environment ref (id or name, scoped to
   *  this project) applied to THIS spawn only — the project's stored
   *  `activeContextId` is neither read nor written. Unknown ref, or a compose
   *  project, is a refusal: a start that quietly ran the wrong environment is
   *  worse than one that did not run. */
  readonly start: (id: ProjectId, context?: string) => Effect.Effect<Accepted, EngineError>
  readonly stop: (id: ProjectId) => Effect.Effect<Accepted, EngineError>
  readonly restart: (id: ProjectId, context?: string) => Effect.Effect<Accepted, EngineError>
  /** Force down, no drain and no waiting. See supervisor.kill.ts. */
  readonly kill: (id: ProjectId) => Effect.Effect<Accepted, EngineError>
  /** Acknowledge a terminal failure: `crashed`/`errored` → `idle`, and nothing
   *  else. No signal, no runner, no process on either side of it. */
  readonly reset: (id: ProjectId) => Effect.Effect<Accepted, EngineError>
  /** Reclaim a project running outside the engine: end the foreign holder, then
   *  start it here. See the implementation for what it refuses to do. */
  readonly takeover: (id: ProjectId, force: boolean) => Effect.Effect<Accepted, EngineError>
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
  const discovery = yield* Discovery
  const scope = yield* Effect.scope
  const rt = yield* Effect.runtime<never>()

  const runners = yield* SynchronizedRef.make(
    HashMap.empty<string, Fiber.RuntimeFiber<void, never>>()
  )

  const deps: RunnerDeps = { runtimeRepo, envRepo, events, config, pty: ptyMgr, rt }

  const start: SupervisorShape["start"] = (id, context) =>
    Effect.gen(function* () {
      const project = yield* projects.get(id).pipe(Effect.mapError(toEngineError))

      // Resolved BEFORE anything is interrupted or spawned, so a typo'd context
      // leaves a running project running and returns the error to the caller.
      // Validating after the stale-runner interrupt below would take the
      // project down to tell the user their flag was wrong.
      let contextId: ContextId | undefined
      if (context !== undefined) {
        if (project.kind === "compose") {
          return yield* Effect.fail(
            new ValidationError({
              message: `${project.name} is a compose stack — its environment comes from ${project.composeFile ?? "the compose file"}, so matisa has nowhere to apply context "${context}"`
            })
          )
        }
        contextId = yield* resolveContextRef(project, context, { envRepo })
      }

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
            // One extra lsof, only on the refusal path, and it changes what the
            // refusal MEANS. Without the holder's working directory this can
            // only say "something is on your port"; with it, the far more
            // common case — the user already started this very project in a
            // terminal — is stated as such, along with the command that fixes
            // it. `port 3000 busy` and `your app is already up` are different
            // problems and must not read the same.
            const cwd =
              holder.pid === undefined
                ? undefined
                : (yield* workingDirs([holder.pid])).get(holder.pid)
            const isSelf = cwd !== undefined && isUnder(cwd, project.root)
            const who = `${holder.processName ?? "an unknown process"}${holder.pid !== undefined ? ` (pid ${holder.pid})` : ""}`
            const message = isSelf
              ? `${project.name} is already running on port ${p.number} — ${who} started from ${cwd}, outside matisa. Use lifecycle.takeover to reclaim it, or stop it yourself first.`
              : `port ${p.number} is already in use by ${who}${cwd !== undefined ? ` running in ${cwd}` : ""} — not managed by matisa, and not recognisable as ${project.name}`
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

      const fiber = yield* runProject(project, deps, contextId).pipe(
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

  const restart: SupervisorShape["restart"] = (id, context) =>
    stop(id).pipe(Effect.flatMap(() => start(id, context)))

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

  // ────────────────────────────────────────────────────────────────────────
  // Takeover — the one operation that deliberately ends a process the engine
  // does not own, so it is also the one with the most to get wrong.
  //
  // The refusal is the important part. Discovery grades its evidence: `root`
  // and `container` mean the holder demonstrably belongs to this project (its
  // working directory is inside the project root, or it carries the container
  // name matisa itself would have used), while `port` means nothing matched
  // except the port number. Acting on `port` evidence would let a stray
  // `matisa takeover api` kill an unrelated program that happened to bind 3000
  // — which is unrecoverable, unlike refusing. So `port` needs `force`, and the
  // refusal names exactly what it found so the user can make that call.
  // ────────────────────────────────────────────────────────────────────────
  const takeover: SupervisorShape["takeover"] = (id, force) =>
    Effect.gen(function* () {
      const project = yield* projects.get(id).pipe(Effect.mapError(toEngineError))
      const claim = yield* discovery.claimFor(id)

      // Nothing foreign is holding it, so there is nothing to take over and
      // `start` is the whole job. Not an error: it is the state the caller
      // wanted, reached without us having to kill anything.
      //
      // Unless the engine is ALREADY running it, in which case the caller is
      // acting on a claim that has since evaporated — a card still showing
      // Reclaim from the last sweep, clicked after the holder quit and the
      // project was started normally. Falling through to `start` there would
      // interrupt the live runner and respawn it: a working dev server bounced,
      // without warning, by the one control whose whole purpose is to avoid
      // killing things blindly. Report the state instead.
      if (claim === undefined) {
        const settled = yield* runtimeRepo.getState(id).pipe(Effect.mapError(toEngineError))
        const state = Option.isSome(settled) ? settled.value.state : "idle"
        return state === "running" || state === "starting"
          ? { id, state }
          : yield* start(id)
      }

      if (claim.evidence === "port" && !force) {
        return yield* Effect.fail(
          new PortBusy({
            port: claim.port ?? 0,
            pid: claim.pid,
            processName: claim.holder,
            message: `${claim.message}. Nothing links it to ${project.name} except the port number, so matisa will not kill it — verify it, then retry with force to proceed.`
          })
        )
      }

      if (project.kind === "docker") {
        // `rm -f`, not `stop`: the container name is what the next start needs
        // back, and a stopped-but-present container still holds it.
        yield* inlineRemove(project.name).pipe(Effect.ignoreLogged)
      } else if (project.kind === "compose") {
        const file = project.composeFile
        if (file !== undefined) yield* composeDownHard(file).pipe(Effect.ignoreLogged)
      } else if (claim.pid !== undefined) {
        yield* discovery.stop(`pid:${claim.pid}`).pipe(Effect.ignore)
      }

      yield* Effect.logInfo(
        `supervisor: took over ${project.name} from ${claim.holder}${claim.pid !== undefined ? ` (pid ${claim.pid})` : ""} — ${claim.evidence} evidence${force ? ", forced" : ""}`
      )

      // The runtime row still says `unmanaged`, and `start` is legal from there
      // (see supervisor.machine.ts) — but the row's pid now points at a corpse,
      // so it is settled to idle first rather than left to be overwritten by
      // whatever the new runner happens to write.
      yield* runtimeRepo.setState(id, { state: "idle" }).pipe(Effect.ignore)
      yield* events.emit(stateChanged(id, "unmanaged", "idle", `taken over from ${claim.holder}`))
      return yield* start(id)
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

  return Supervisor.of({ start, stop, restart, kill, reset, takeover, status })
})

export const SupervisorLive = Layer.scoped(Supervisor, make)
