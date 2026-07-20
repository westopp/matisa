import { Duration, Effect, Either, Ref, Runtime } from "effect"
import { SessionId, type Project } from "@matisa/core"
import type { EnvRepoShape, RuntimeRepoShape, RuntimePatch } from "@matisa/store"
import { crashed, logLine, stateChanged } from "../../shared/events.js"
import { resolveEnv } from "../catalog/catalog.env-resolve.js"
import type { KeychainShape } from "../catalog/providers/catalog.providers.keychain.types.js"
import type { EventsHubShape } from "../../server/server.events-hub.js"
import type { AppConfigShape } from "../../config/config.app-config.js"
import type { PtyManagerShape } from "../pty/pty.services.js"
import { runSessionId } from "../pty/pty.session.js"
import { restartDelayMs } from "./supervisor.backoff.js"
import { Event, runtimeStateOf, State, transition } from "./supervisor.machine.js"
import { spawnChild } from "./supervisor.spawn.js"

// ────────────────────────────────────────────────────────────────────────────
// runProject — one project's supervised lifetime loop. Real process events
// (spawn / exit) are fed into the pure FSM; each transition persists runtime_state
// and emits a state_changed event. On an unclean exit it records a crash and
// restarts on the expo-capped backoff up to maxAttempts, then lands in `errored`.
// The whole loop is Effect<void> — the Supervisor forks it per project under
// catchAllCause, so a failure degrades only that project (crash-isolation).
//
// The child runs on a PTY and is registered with PtyManager as the project's
// run session (`run:<projectId>`): clients attach for live output + scrollback
// and answer interactive prompts via pty.input. PTY output doubles as log_line
// events. After the leader exits, the whole process group is swept with SIGTERM
// so grandchildren (npm run → server) never outlive the reported state.
// ────────────────────────────────────────────────────────────────────────────

export interface RunnerDeps {
  readonly runtimeRepo: RuntimeRepoShape
  readonly envRepo: EnvRepoShape
  readonly keychain: KeychainShape
  readonly events: EventsHubShape
  readonly config: AppConfigShape
  readonly pty: PtyManagerShape
  readonly rt: Runtime.Runtime<never>
}

const patchFor = (state: State, sessionId?: SessionId): RuntimePatch => {
  switch (state._tag) {
    case "Running":
      return { state: "running", pid: state.pid, since: state.since, sessionId }
    case "Unmanaged":
      return { state: "unmanaged", pid: state.pid }
    case "Crashed":
      return { state: "crashed", exitCode: state.code ?? undefined, sessionId }
    case "Starting":
      return { state: "starting" }
    case "Stopping":
      return { state: "stopping" }
    case "Errored":
      return { state: "errored" }
    case "Idle":
      return { state: "idle", sessionId }
  }
}

/** SIGTERM the child's whole process group — reaps grandchildren the leader
 * left behind. The leader is a session leader (forkpty), so pgid == pid. */
const sweepGroup = (pid: number): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      // group already fully gone — the common case
    }
  })

export const runProject = (project: Project, deps: RunnerDeps): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<State>(State.Idle())
    const sessionId = SessionId.make(runSessionId(project.id))

    const apply = (event: Event, reason?: string) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(ref)
        const next = transition(current, event)
        if (next._tag === "None") return
        const ns = next.value
        yield* Ref.set(ref, ns)
        const from = runtimeStateOf(current)
        const to = runtimeStateOf(ns)
        yield* deps.runtimeRepo.setState(project.id, patchFor(ns, sessionId)).pipe(Effect.ignore)
        if (from !== to) yield* deps.events.emit(stateChanged(project.id, from, to, reason))
      })

    const lifetime = (attempt: number) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* apply(Event.Start({ attempt }))

          const env = yield* resolveEnv(project, deps).pipe(
            Effect.catchAll(() => Effect.succeed({} as Record<string, string>))
          )

          const spawned = yield* spawnChild(project, env).pipe(Effect.either)
          if (Either.isLeft(spawned)) {
            yield* apply(Event.Fault({ reason: spawned.left.errorMessage }))
            return
          }
          const child = spawned.right

          yield* deps.runtimeRepo
            .recordSpawn({ projectId: project.id, pid: child.pid, pgid: child.pid })
            .pipe(Effect.ignore)

          // Register the run session BEFORE declaring Running so an attach
          // races no gap. Replaces the previous attempt's session (old pumps
          // complete via hub shutdown).
          yield* deps.pty.register({
            sessionId,
            projectId: project.id,
            kind: "run",
            pty: child.pty,
            cols: child.cols,
            rows: child.rows
          })

          yield* apply(Event.Healthy({ pid: child.pid, since: Date.now() }))

          // PTY output doubles as the durable log stream, out of band via the
          // runtime. (Single merged stream — a TTY has no stderr split.)
          child.pty.onData((chunk: string) => {
            Runtime.runFork(deps.rt)(deps.events.emit(logLine(project.id, "stdout", chunk)))
          })

          const exit = yield* child.awaitExit
          yield* deps.pty.sessionExited(sessionId, exit.code)
          // The leader is gone; sweep the group so grandchildren die with it.
          yield* sweepGroup(child.pid)
          yield* apply(
            Event.Exit({ code: exit.code, signal: exit.signal }),
            `exited code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}`
          )
        })
      )

    const loop = (attempt: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* lifetime(attempt)
        const state = yield* Ref.get(ref)
        if (state._tag !== "Crashed") return

        yield* deps.events.emit(
          crashed(project.id, state.code ?? undefined, state.signal ?? undefined)
        )
        yield* deps.runtimeRepo
          .recordCrash({
            projectId: project.id,
            exitCode: state.code ?? undefined,
            signal: state.signal ?? undefined
          })
          .pipe(Effect.ignore)

        if (attempt + 1 >= deps.config.backoff.maxAttempts) {
          yield* apply(Event.Fault({ reason: "max restart attempts reached" }))
          return
        }

        yield* Effect.sleep(
          Duration.millis(restartDelayMs(attempt, deps.config.backoff.base, deps.config.backoff.cap))
        )
        yield* loop(attempt + 1)
      })

    yield* loop(0)
  })
