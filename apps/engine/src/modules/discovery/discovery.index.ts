import { Context, Duration, Effect, Layer, Option, SynchronizedRef } from "effect"
import {
  NotFound,
  ValidationError,
  type DiscoveryActionResult,
  type DiscoverySnapshot,
  type EngineError,
  type ForeignClaim,
  type ListeningPort,
  type ProjectId,
  type RuntimeState
} from "@matisa/core"
import { ProjectsRepo, RuntimeRepo } from "@matisa/store"
import {
  DISCOVERY_TERM_GRACE_MS,
  DISCOVERY_TTL_MS,
  DOCKER_STOP_GRACE_S
} from "../../config/config.constants.js"
import { EventsHub } from "../../server/server.events-hub.js"
import { stateChanged } from "../../shared/events.js"
import { toEngineError } from "../../shared/error-map.js"
import { DockerDaemon } from "../docker/docker.daemon.js"
import { sh } from "../docker/docker.shell.js"
import { Event, State, runtimeStateOf, transition } from "../supervisor/supervisor.machine.js"
import { classify } from "./discovery.classify.js"
import { appNameAt } from "./discovery.manifest.js"
import {
  composeStacks,
  containers,
  listeningPorts,
  processTree,
  workingDirs
} from "./discovery.probes.js"

// ────────────────────────────────────────────────────────────────────────────
// Discovery — what is running on this machine that the engine did not start.
//
// Everything else in the engine derives state from events it caused: it spawned
// the child, so it hears the exit. Foreign processes give us nothing, so the
// only way to see them is to go and look, and looking is expensive (several
// shell-outs per sweep). Two things keep that honest:
//
//   • the sweep is caller-driven, never a background timer. Nothing probes this
//     machine unless a client asked a question that needs the answer.
//   • results are cached for DISCOVERY_TTL_MS behind a SynchronizedRef, so three
//     clients polling at once share one probe rather than triplicating it.
//
// A sweep also RECONCILES: a project whose port turns out to be held by someone
// else moves to `unmanaged`, and moves back to `idle` when the holder goes. Both
// transitions go through the supervisor FSM rather than being written directly,
// because `unmanaged` is a state with rules — it can be started out of, but it
// cannot be dismissed, and the FSM is where that lives.
// ────────────────────────────────────────────────────────────────────────────

export interface DiscoveryShape {
  readonly snapshot: (refresh?: boolean) => Effect.Effect<DiscoverySnapshot, EngineError>
  /** The claim held against one project, or undefined when it is free. */
  readonly claimFor: (id: ProjectId) => Effect.Effect<ForeignClaim | undefined, EngineError>
  readonly stop: (ref: string) => Effect.Effect<DiscoveryActionResult, EngineError>
  readonly start: (ref: string) => Effect.Effect<DiscoveryActionResult, EngineError>
}

export class Discovery extends Context.Tag("Discovery")<Discovery, DiscoveryShape>() {}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const signalGroup = (pid: number, signal: "SIGTERM" | "SIGKILL"): void => {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

/** `pid:1234` / `container:api-db-1` → its parts. */
const parseRef = (
  ref: string
): { kind: "process"; pid: number } | { kind: "container"; name: string } | undefined => {
  if (ref.startsWith("pid:")) {
    const pid = Number(ref.slice(4))
    return Number.isInteger(pid) && pid > 1 ? { kind: "process", pid } : undefined
  }
  if (ref.startsWith("container:")) {
    const name = ref.slice("container:".length)
    return name.length > 0 ? { kind: "container", name } : undefined
  }
  return undefined
}

const badRef = (ref: string) =>
  new ValidationError({
    field: "ref",
    message: `"${ref}" is not a discovery ref — expected pid:<number> or container:<name>, as printed by discovery.snapshot`
  })

/** Attach cwd and a manifest name to every listener. The manifest lookup is
 *  memoised per directory: a monorepo commonly has four dev servers sharing one
 *  root, and reading the same package.json four times is pure waste. */
const enrich = (
  rows: ReadonlyArray<ListeningPort>,
  cwds: ReadonlyMap<number, string>
): ReadonlyArray<ListeningPort> => {
  const names = new Map<string, string | undefined>()
  return rows.map((row) => {
    const cwd = cwds.get(row.pid)
    if (cwd === undefined) return row
    if (!names.has(cwd)) names.set(cwd, appNameAt(cwd))
    const appName = names.get(cwd)
    return appName === undefined ? { ...row, cwd } : { ...row, cwd, appName }
  })
}

interface Cached {
  readonly snapshot: DiscoverySnapshot
  readonly at: number
}

const make = Effect.gen(function* () {
  const projectsRepo = yield* ProjectsRepo
  const runtimeRepo = yield* RuntimeRepo
  const daemon = yield* DockerDaemon
  const events = yield* EventsHub

  const cache = yield* SynchronizedRef.make<Cached | undefined>(undefined)

  // ── the sweep ─────────────────────────────────────────────────────────────

  const probe = Effect.gen(function* () {
    const listeners = yield* listeningPorts()
    const pids = [...new Set(listeners.map((l) => l.pid))]

    const dockerUp = yield* daemon.probe()
    // The remaining probes are independent, and the docker pair is only worth
    // running at all once the daemon has answered.
    const [cwds, ours, dockerContainers, stacks] = yield* Effect.all(
      [
        workingDirs(pids),
        processTree(process.pid),
        dockerUp ? containers() : Effect.succeed([]),
        dockerUp ? composeStacks() : Effect.succeed([])
      ],
      { concurrency: 4 }
    )

    const [projects, states, spawns] = yield* Effect.all([
      projectsRepo.list(),
      runtimeRepo.all(),
      runtimeRepo.liveSpawns()
    ]).pipe(Effect.mapError(toEngineError))

    const result = classify({
      projects,
      states: new Map(states.map((s) => [s.projectId as string, s.state])),
      listeners: enrich(listeners, cwds),
      containers: dockerContainers,
      stacks,
      dockerDaemonRunning: dockerUp,
      // The engine's whole process tree, not just its recorded spawns: that
      // covers the engine itself (it holds the WS bridge port, squarely in a
      // dev range), the Caddy and dns-sd the exposure module runs, and the
      // grandchildren a spawn record never mentions — `npm run dev` binds its
      // port from the `vite` it forked. Spawn pids are unioned in anyway, since
      // a `ps` that failed must not turn our own children into strangers.
      ourPids: new Set([...ours, ...spawns.map((s) => s.pid)])
    })

    const snapshot: DiscoverySnapshot = {
      takenAt: Date.now(),
      dockerDaemonRunning: dockerUp,
      claims: result.claims,
      unmanaged: result.unmanaged
    }

    yield* reconcile(snapshot, states)
    return snapshot
  })

  /** Move projects between `idle` and `unmanaged` to match what was just seen.
   *  Only those two states are touched: every other state describes something
   *  the engine itself is doing, and an observation of the outside world is not
   *  entitled to overrule it. */
  const reconcile = (
    snapshot: DiscoverySnapshot,
    states: ReadonlyArray<{ readonly projectId: ProjectId; readonly state: RuntimeState }>
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // Three verdicts, not two, because the probe that separates them is
      // allowed to come back empty.
      //
      //   STRONG  — the holder runs from this project's directory, or is its
      //             container. "This project is running, we just did not start
      //             it": what `unmanaged` asserts and what Reclaim acts on.
      //   WEAK    — cwd was READ and is not this project's. The project is not
      //             running at all; it is BLOCKED by a stranger. Published and
      //             rendered on the card, but it must not move the state.
      //   UNKNOWN — cwd could not be read (`lsof -d cwd` is best-effort: a 5s
      //             timeout, unreadable pids simply omitted, and the probe
      //             resolves with whatever it got). This looks EXACTLY like WEAK
      //             on the wire — `sameRoot` is false either way — but it is not
      //             evidence of anything. Treating it as weak made a degraded
      //             sweep release a genuinely unmanaged project to `idle` with
      //             "the foreign process holding it is gone", which was untrue,
      //             and the next healthy sweep put it straight back: a flap
      //             driven by nothing but a slow lsof.
      const strong = (c: ForeignClaim): boolean => c.evidence !== "port"
      const conclusive = (c: ForeignClaim): boolean => strong(c) || c.cwd !== undefined

      const claimed = new Map(
        snapshot.claims.filter(strong).map((c) => [c.projectId as string, c])
      )
      // What the release loop consults. A project with an inconclusive claim
      // appears here but not above, so it is neither promoted nor released —
      // the state it already had is the best answer available.
      const spoken = new Set(
        snapshot.claims.filter((c) => !conclusive(c)).map((c) => c.projectId as string)
      )
      const current = new Map(states.map((s) => [s.projectId as string, s.state]))

      for (const [id, claim] of claimed) {
        if ((current.get(id) ?? "idle") !== "idle") continue
        const pid = claim.pid ?? 0
        const next = transition(State.Idle(), Event.ForeignListener({ pid }))
        if (Option.isNone(next)) continue
        const to = runtimeStateOf(next.value)
        yield* runtimeRepo
          .setState(claim.projectId, { state: to, pid: claim.pid })
          .pipe(Effect.ignore)
        yield* events.emit(stateChanged(claim.projectId, "idle", to, claim.message))
      }

      for (const [id, state] of current) {
        if (state !== "unmanaged" || claimed.has(id) || spoken.has(id)) continue
        const next = transition(State.Unmanaged({ pid: 0 }), Event.Released())
        if (Option.isNone(next)) continue
        const to = runtimeStateOf(next.value)
        const projectId = id as ProjectId
        yield* runtimeRepo.setState(projectId, { state: to }).pipe(Effect.ignore)
        yield* events.emit(
          stateChanged(projectId, "unmanaged", to, "the foreign process holding it is gone")
        )
      }
    })

  // SynchronizedRef.updateAndGetEffect serializes: a second caller arriving
  // mid-probe waits for the first one's result instead of starting its own.
  const snapshot: DiscoveryShape["snapshot"] = (refresh = false) =>
    SynchronizedRef.updateAndGetEffect(cache, (cached) =>
      !refresh && cached !== undefined && Date.now() - cached.at < DISCOVERY_TTL_MS
        ? Effect.succeed(cached)
        : probe.pipe(Effect.map((s): Cached => ({ snapshot: s, at: Date.now() })))
    ).pipe(Effect.flatMap((c) => (c === undefined ? probe : Effect.succeed(c.snapshot))))

  const invalidate = SynchronizedRef.set(cache, undefined)

  const claimFor: DiscoveryShape["claimFor"] = (id) =>
    snapshot(true).pipe(Effect.map((s) => s.claims.find((c) => c.projectId === id)))

  // ── acting on what was found ──────────────────────────────────────────────

  const stopProcess = (pid: number): Effect.Effect<DiscoveryActionResult, EngineError> =>
    Effect.gen(function* () {
      if (!alive(pid)) {
        return { ref: `pid:${pid}`, running: false, message: `pid ${pid} is already gone` }
      }
      // Group-signalled, same as a supervised stop: a dev server that spawned
      // its real worker leaves the worker holding the port if only the leader
      // is signalled, and the port is the whole reason we are here.
      signalGroup(pid, "SIGTERM")
      yield* Effect.sleep(Duration.millis(DISCOVERY_TERM_GRACE_MS))
      const stubborn = alive(pid)
      if (stubborn) signalGroup(pid, "SIGKILL")
      yield* invalidate
      return {
        ref: `pid:${pid}`,
        running: false,
        message: stubborn
          ? `pid ${pid} ignored SIGTERM and was killed`
          : `pid ${pid} stopped`
      }
    })

  const stopContainer = (name: string): Effect.Effect<DiscoveryActionResult, EngineError> =>
    sh("docker", ["stop", "-t", String(DOCKER_STOP_GRACE_S), name], {
      timeoutMs: (DOCKER_STOP_GRACE_S + 20) * 1_000
    }).pipe(
      Effect.andThen(invalidate),
      Effect.as({
        ref: `container:${name}`,
        running: false,
        message: `container ${name} stopped`
      }),
      Effect.catchTag("DockerCliError", (e) =>
        Effect.fail(
          new NotFound({
            entity: "container",
            id: name,
            message: `could not stop container ${name}: ${e.stderrTail || "docker refused"}`
          })
        )
      )
    )

  const stop: DiscoveryShape["stop"] = (ref) => {
    const parsed = parseRef(ref)
    if (parsed === undefined) return Effect.fail(badRef(ref))
    return parsed.kind === "process" ? stopProcess(parsed.pid) : stopContainer(parsed.name)
  }

  const start: DiscoveryShape["start"] = (ref) => {
    const parsed = parseRef(ref)
    if (parsed === undefined) return Effect.fail(badRef(ref))
    // A stopped process is not restartable from here and pretending otherwise
    // would be the worst kind of guess: we know its old command line at best,
    // never its environment or working directory. Adding it to the catalog is
    // the supported way to get a start button.
    if (parsed.kind === "process") {
      return Effect.fail(
        new ValidationError({
          field: "ref",
          message: `${ref} is a process — matisa can stop it but cannot start it again, because it never knew how it was launched. Add it as a project to get a start button.`
        })
      )
    }
    return sh("docker", ["start", parsed.name], { timeoutMs: 60_000 }).pipe(
      Effect.andThen(invalidate),
      Effect.as({
        ref,
        running: true,
        message: `container ${parsed.name} started`
      }),
      Effect.catchTag("DockerCliError", (e) =>
        Effect.fail(
          new NotFound({
            entity: "container",
            id: parsed.name,
            message: `could not start container ${parsed.name}: ${e.stderrTail || "docker refused"}`
          })
        )
      )
    )
  }

  yield* Effect.logInfo(
    "discovery: probing lsof/docker on demand (TTL " + DISCOVERY_TTL_MS / 1000 + "s)"
  )

  return Discovery.of({ snapshot, claimFor, stop, start })
})

export const DiscoveryLive = Layer.effect(Discovery, make)
