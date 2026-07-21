import { Effect, Either, Runtime } from "effect"
import type { Project } from "@matisa/core"
import { crashed, logLine } from "../../shared/events.js"
import { resolveEnv } from "../catalog/catalog.env-resolve.js"
import {
  composeDown,
  composeUp,
  containerLogTail,
  containerName,
  inlineRun,
  inlineStop,
  inspectPid
} from "../docker/docker.actions.js"
import { watchContainer } from "../docker/docker.events.js"
import { spawn } from "node:child_process"
import { Event } from "./supervisor.machine.js"
import { makeDriver, probeReadiness, summarizeFailure, type RunnerDeps } from "./supervisor.runner.js"

// ────────────────────────────────────────────────────────────────────────────
// Docker & compose lifetimes.
//
// docker: the container runs `--restart unless-stopped` — DOCKER owns
// restarts (the daemon outlives the engine). The FSM is an observer: real
// container events (start / die with exit code / stop) from `docker events`
// drive the same transitions process projects get. lifecycle.stop interrupts
// the fiber; scope release stops the container.
//
// compose: the stack is the unit — up → Running, interrupt → down. No
// per-container crash detection inside a stack (POC; logged, not silent).
// ────────────────────────────────────────────────────────────────────────────

/** Chunk → complete lines. A `data` event is an arbitrary byte slice, not a
 *  line; the remainder is held until its newline arrives so every emitted
 *  log_line is exactly one line. */
const lineSplitter = (onLine: (line: string) => void): ((d: Buffer) => void) => {
  let rest = ""
  return (d) => {
    const parts = (rest + d.toString("utf8")).split("\n")
    rest = parts.pop() ?? ""
    for (const line of parts) onLine(line)
  }
}

/** Compose multiplexes every service into one stream, prefixing each line
 *  `<service>-<n>  | body`. Parsed HERE, not in clients: the format is
 *  compose's, and two clients should not each re-implement it. A line that
 *  does not match (compose's own status output) passes through unattributed. */
const COMPOSE_PREFIX = /^(\S+?)-\d+\s+\|\s?(.*)$/
export const parseComposeLine = (raw: string): { line: string; service?: string } => {
  const m = COMPOSE_PREFIX.exec(raw)
  return m === null ? { line: raw } : { line: m[2] ?? "", service: m[1] }
}

/** Spawn a log tail whose child dies with the scope. */
const streamLogs = (
  args: ReadonlyArray<string>,
  emit: (stream: "stdout" | "stderr", line: string) => void
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] })
      child.stdout.on("data", lineSplitter((line) => emit("stdout", line)))
      child.stderr.on("data", lineSplitter((line) => emit("stderr", line)))
      return child
    }),
    (child) =>
      Effect.sync(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // gone
        }
      })
  )

/** Pipe `docker logs -f` into log_line events. */
const streamContainerLogs = (project: Project, cname: string, deps: RunnerDeps) =>
  streamLogs(["logs", "-f", "--tail", "0", cname], (stream, line) => {
    Runtime.runFork(deps.rt)(deps.events.emit(logLine(project.id, stream, line)))
  })

/** Pipe the stack's merged `compose logs -f` into log_line events, each line
 *  attributed to its service. */
const streamComposeLogs = (project: Project, file: string, deps: RunnerDeps) =>
  streamLogs(["compose", "-f", file, "logs", "-f", "--tail", "0"], (stream, raw) => {
    const { line, service } = parseComposeLine(raw)
    Runtime.runFork(deps.rt)(deps.events.emit(logLine(project.id, stream, line, service)))
  })

export const runDocker = (project: Project, deps: RunnerDeps): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* makeDriver(project, deps)
      const startedAt = Date.now()
      yield* driver.apply(Event.Start({ attempt: 0 }))

      const env = yield* resolveEnv(project, deps).pipe(
        Effect.catchAll(() => Effect.succeed({} as Record<string, string>))
      )

      const ran = yield* inlineRun(
        project.name,
        project.image ?? "",
        project.ports.map((p) => p.number),
        env
      ).pipe(Effect.either)

      if (Either.isLeft(ran)) {
        // Surface the docker CLI's stderr tail — the user always knows WHY.
        yield* driver.apply(Event.Fault({ reason: ran.left.stderrTail }))
        yield* deps.runtimeRepo
          .recordCrash({ projectId: project.id, summary: ran.left.stderrTail })
          .pipe(Effect.ignore)
        return
      }
      const cname = ran.right

      const pid = yield* inspectPid(cname).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      yield* driver.apply(Event.Healthy({ pid: pid ?? 0, since: Date.now() }))
      yield* probeReadiness(project, driver).pipe(Effect.forkScoped)
      yield* streamContainerLogs(project, cname, deps)

      // Container events drive the FSM from here. die≠0 → Crashed (+ tail);
      // docker's unless-stopped brings it back → start → Running again.
      yield* watchContainer(cname, (ev) => {
        Runtime.runFork(deps.rt)(
          Effect.gen(function* () {
            if (ev.status === "start") {
              yield* driver.apply(Event.Start({ attempt: 0 }))
              const npid = yield* inspectPid(cname).pipe(
                Effect.catchAll(() => Effect.succeed(undefined))
              )
              yield* driver.apply(Event.Healthy({ pid: npid ?? 0, since: Date.now() }))
            } else {
              const clean = ev.status === "stop" || ev.exitCode === 0
              yield* driver.apply(
                Event.Exit({ code: ev.exitCode, signal: null }),
                `container ${ev.status} code=${ev.exitCode ?? "null"}`
              )
              if (!clean) {
                const tail = yield* containerLogTail(cname, 15)
                const summary = summarizeFailure(tail, ev.exitCode, null, Date.now() - startedAt)
                yield* deps.events.emit(
                  crashed(project.id, ev.exitCode ?? undefined, undefined, undefined, summary, tail)
                )
                yield* deps.runtimeRepo
                  .recordCrash({
                    projectId: project.id,
                    exitCode: ev.exitCode ?? undefined,
                    summary,
                    logTail: tail
                  })
                  .pipe(Effect.ignore)
              }
            }
          })
        )
      })

      // Stay alive observing until lifecycle.stop interrupts the fiber; the
      // scope release then stops the container (errors tolerated — the daemon
      // may already be down, in which case the container is down with it).
      yield* Effect.addFinalizer(() => inlineStop(project.name).pipe(Effect.ignore))
      yield* Effect.never
    })
  )

export const runCompose = (project: Project, deps: RunnerDeps): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* makeDriver(project, deps)
      yield* driver.apply(Event.Start({ attempt: 0 }))

      const file = project.composeFile ?? ""
      const up = yield* composeUp(file).pipe(Effect.either)
      if (Either.isLeft(up)) {
        yield* driver.apply(Event.Fault({ reason: up.left.stderrTail }))
        yield* deps.runtimeRepo
          .recordCrash({ projectId: project.id, summary: up.left.stderrTail })
          .pipe(Effect.ignore)
        return
      }

      // The stack is the unit: up = Running (pid 0 → no pid in status).
      yield* driver.apply(Event.Healthy({ pid: 0, since: Date.now() }))
      yield* probeReadiness(project, driver).pipe(Effect.forkScoped)
      yield* streamComposeLogs(project, file, deps)

      yield* Effect.addFinalizer(() => composeDown(file).pipe(Effect.ignore))
      yield* Effect.never
    })
  )
