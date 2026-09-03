import { Effect, Either, Ref, Runtime } from "effect"
import { SessionId, type ContextId, type Project } from "@matisa/core"
import type { EnvRepoShape, RuntimeRepoShape, RuntimePatch } from "@matisa/store"
import { crashed, healthChanged, stateChanged } from "../../shared/events.js"
import { resolveEnv } from "../catalog/catalog.env-resolve.js"
import type { EventsHubShape } from "../../server/server.events-hub.js"
import type { AppConfigShape } from "../../config/config.app-config.js"
import type { PtyManagerShape } from "../pty/pty.services.js"
import { runSessionId } from "../pty/pty.session.js"
import { START_TIMEOUT_MS } from "../../config/config.constants.js"
import { Event, runtimeStateOf, State, transition } from "./supervisor.machine.js"
import { awaitPortBound } from "./supervisor.probe.js"
import { spawnChild, type Child } from "./supervisor.spawn.js"
import { runCompose, runDocker } from "./supervisor.run-docker.js"

// ────────────────────────────────────────────────────────────────────────────
// runProject — one project's supervised lifetime, dispatched by kind:
//   process — PTY child, run once; a crash is terminal and the user restarts
//   docker  — matisa.<name> container; docker owns restarts (unless-stopped),
//             the FSM observes real container events
//   compose — whole stack via docker compose; up/down is the lifecycle unit
// Every kind feeds the SAME pure FSM; each transition persists runtime_state
// and emits state_changed. Forked per project under catchAllCause — a project
// failure degrades only that project (crash-isolation).
// ────────────────────────────────────────────────────────────────────────────

export interface RunnerDeps {
  readonly runtimeRepo: RuntimeRepoShape
  readonly envRepo: EnvRepoShape
  readonly events: EventsHubShape
  readonly config: AppConfigShape
  readonly pty: PtyManagerShape
  readonly rt: Runtime.Runtime<never>
}

const patchFor = (state: State, sessionId?: SessionId): RuntimePatch => {
  switch (state._tag) {
    case "Running":
      return {
        state: "running",
        // pid 0 = "no meaningful pid" (compose stacks)
        pid: state.pid === 0 ? undefined : state.pid,
        since: state.since,
        sessionId
      }
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

/** Shared FSM driver: holds the state Ref, persists each transition, emits
 * state_changed, and exposes health updates that preserve the state row. */
export interface Driver {
  readonly apply: (event: Event, reason?: string) => Effect.Effect<void>
  readonly current: Effect.Effect<State>
  readonly setHealth: (health: "waiting" | "ready" | "timeout" | "unknown", message?: string) => Effect.Effect<void>
}

export const makeDriver = (
  project: Project,
  deps: RunnerDeps,
  sessionId?: SessionId
): Effect.Effect<Driver> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<State>(State.Idle())

    const apply: Driver["apply"] = (event, reason) =>
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

    const setHealth: Driver["setHealth"] = (health, message) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(ref)
        yield* deps.runtimeRepo
          .setState(project.id, { ...patchFor(state, sessionId), health })
          .pipe(Effect.ignore)
        yield* deps.events.emit(healthChanged(project.id, health, message))
      })

    return { apply, current: Ref.get(ref), setHealth }
  })

/** Probe the project's first declared port until bound or the window closes.
 * Runs during `starting` only — once resolved the engine stops watching. */
export const probeReadiness = (
  project: Project,
  driver: Driver
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const port = project.ports[0]?.number
    if (port === undefined) {
      yield* driver.setHealth("unknown")
      return
    }
    yield* driver.setHealth("waiting")
    const bound = yield* awaitPortBound(port, START_TIMEOUT_MS)
    const state = yield* driver.current
    if (state._tag !== "Running") return // exited/crashed meanwhile — moot
    if (bound) {
      yield* driver.setHealth("ready")
    } else {
      yield* driver.setHealth(
        "timeout",
        `port ${port} not bound within ${START_TIMEOUT_MS / 1000}s — process alive but not serving`
      )
    }
  })

/** Old-app style failure summary: last meaningful output line + exit shape. */
export const summarizeFailure = (
  tail: string,
  exitCode: number | null,
  signal: string | null,
  aliveMs: number
): string => {
  const lastLine = tail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .at(-1)
  const how = signal ? `signal ${signal}` : `exit code ${exitCode ?? "unknown"}`
  const alive = `${(aliveMs / 1000).toFixed(1)}s`
  return lastLine !== undefined
    ? `${how} after ${alive} — last output: ${lastLine.slice(0, 200)}`
    : `${how} after ${alive} with no output`
}

const runProcess = (
  project: Project,
  deps: RunnerDeps,
  contextId?: ContextId
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sessionId = SessionId.make(runSessionId(project.id))
    const driver = yield* makeDriver(project, deps, sessionId)

    const lifetime = (attempt: number) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* driver.apply(Event.Start({ attempt }))

          const env = yield* resolveEnv(project, deps, contextId).pipe(
            Effect.catchAll(() => Effect.succeed({} as Record<string, string>))
          )

          // A session that is over must SAY so, however it ended. The line near
          // the bottom of this block reports the exit code when the child is
          // reaped normally, but `lifecycle.stop` and `restart` interrupt this
          // fiber — so that line never runs, and every attached reader (the
          // desktop pane, `logs -f`) was left holding a bridge to a dead pty
          // with nothing to tell it. The next start re-registers the SAME
          // session id, which shuts the old hub down silently, so the stale
          // attach never recovered on its own. A finalizer runs on every path;
          // `sessionExited` is idempotent, so the normal exit still reports its
          // real code and this becomes a no-op.
          //
          // BEFORE the spawn, because scope finalizers run LIFO and
          // `spawnChild` is an acquireRelease whose release is the graceful
          // stop — SIGTERM, the child's own drain, then the SIGKILL backstop.
          // Registered after it, this would publish the exit FIRST: the bridge
          // pump returns on an exit frame, so every byte the app printed while
          // shutting down ("draining…", a flush, a goodbye) would be dropped on
          // the floor, and the pane would go quiet at the exact moment a slow
          // stop is worth watching. Registered here it runs LAST, after the
          // child is genuinely reaped.
          //
          // Safe on the spawn-failure path below: `sessionExited` no-ops for a
          // session id that was never registered, which is why `handle` can
          // still be undefined here.
          //
          // The handle is passed so the manager can tell WHICH lifetime this
          // reports on. `run:<id>` is reused by every start of the project, so a
          // teardown that overlaps the next start would otherwise mark the fresh
          // session dead — the same "terminal says it exited while the app runs"
          // bug from the other direction.
          let handle: Child["pty"] | undefined
          yield* Effect.addFinalizer(() => deps.pty.sessionExited(sessionId, null, handle))

          const spawned = yield* spawnChild(project, env).pipe(Effect.either)
          if (Either.isLeft(spawned)) {
            yield* driver.apply(Event.Fault({ reason: spawned.left.errorMessage }))
            // Nothing ran, so no crash record would ever be written — and the
            // reason (bad program, missing cwd) is exactly what the user needs.
            yield* deps.runtimeRepo
              .recordCrash({
                projectId: project.id,
                kind: "error",
                summary: spawned.left.errorMessage
              })
              .pipe(Effect.ignore)
            return
          }
          const child = spawned.right
          handle = child.pty
          const spawnedAt = Date.now()

          yield* deps.runtimeRepo
            .recordSpawn({ projectId: project.id, pid: child.pid, pgid: child.pid })
            .pipe(Effect.ignore)

          // Register the run session BEFORE declaring Running so an attach
          // races no gap.
          yield* deps.pty.register({
            sessionId,
            projectId: project.id,
            kind: "run",
            pty: child.pty,
            cols: child.cols,
            rows: child.rows
          })

          yield* driver.apply(Event.Healthy({ pid: child.pid, since: Date.now() }))

          // Readiness probe races the child's lifetime; both scoped fibers.
          yield* probeReadiness(project, driver).pipe(Effect.forkScoped)

          // No log_line emission here — that would be the SECOND stream of this
          // output. PtyManager.register (above) already feeds scrollback and the
          // pty.output bridge, which is how every renderer of process output —
          // the desktop terminal, `logs -f` — actually reads it. The log_line
          // copy doubled every chunk on the socket for a ring buffer no process
          // surface renders. Cost: `watch`/`events` no longer carry process
          // stdout (docker/compose still emit; they have no PTY).

          const exit = yield* child.awaitExit
          yield* deps.pty.sessionExited(sessionId, exit.code, child.pty)
          // Leader gone — sweep the group so grandchildren die with it.
          yield* Effect.sync(() => {
            try {
              process.kill(-child.pid, "SIGTERM")
            } catch {
              // group already fully gone — the common case
            }
          })
          yield* driver.apply(
            Event.Exit({ code: exit.code, signal: exit.signal }),
            `exited code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}`
          )
          return spawnedAt
        })
      )

    // One lifetime, and a crash ends it. There is no restart curve: the engine
    // used to re-run a crashed project up to five times on an expo backoff,
    // which spent half a minute cycling the project through starting → crashed
    // → starting and fixed nothing a manual start would not — the command was
    // wrong, and running it four more times kept it wrong. Crashed is a state
    // the user can see, read the reason for, and act on.
    const startedAt = Date.now()
    yield* lifetime(0)
    const state = yield* driver.current
    if (state._tag !== "Crashed") return

    // Surface WHY: session scrollback tail + old-app style summary.
    const tail = yield* deps.pty.scrollbackTail(sessionId, 15)
    const summary = summarizeFailure(tail, state.code, state.signal, Date.now() - startedAt)
    yield* deps.events.emit(
      crashed(project.id, state.code ?? undefined, state.signal ?? undefined, undefined, summary, tail)
    )
    yield* deps.runtimeRepo
      .recordCrash({
        projectId: project.id,
        kind: "crash",
        exitCode: state.code ?? undefined,
        signal: state.signal ?? undefined,
        summary,
        logTail: tail
      })
      .pipe(Effect.ignore)
  })

/** `contextId` is this lifetime's one-off environment override — see
 *  `resolveEnv`. It rides the lifetime rather than the project row, so nothing
 *  outlives the run that asked for it. */
export const runProject = (
  project: Project,
  deps: RunnerDeps,
  contextId?: ContextId
): Effect.Effect<void> => {
  switch (project.kind) {
    case "docker":
      return runDocker(project, deps, contextId)
    case "compose":
      // No context here by construction: a compose stack takes its environment
      // from the compose file, so the engine has nowhere to inject one and
      // `supervisor.start` refuses the override rather than dropping it.
      return runCompose(project, deps)
    case "process":
      return runProcess(project, deps, contextId)
  }
}
