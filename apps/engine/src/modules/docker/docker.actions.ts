import { Effect } from "effect"
import { dirname } from "node:path"
import { DOCKER_STOP_GRACE_S } from "../../config/config.constants.js"
import type { DockerCliError } from "./docker.errors.js"
import { sh } from "./docker.shell.js"

// ────────────────────────────────────────────────────────────────────────────
// Docker CLI actions — the engine-side port of the old app's DockerActions.
// Inline (single-container) ops address containers as `matisa.<name>` so ours
// are distinguishable from the user's; compose ops treat the stack as the
// unit. Containers run with `--restart unless-stopped`: DOCKER owns restarts
// (the daemon outlives the engine), the supervisor FSM observes real state
// via `docker events`.
// ────────────────────────────────────────────────────────────────────────────

export const CONTAINER_PREFIX = "matisa."
export const containerName = (projectName: string): string => `${CONTAINER_PREFIX}${projectName}`

const DOCKER = "docker"

/** Cheap daemon probe — the single source of daemon truth for gating. */
export const daemonRunning = (): Effect.Effect<boolean> =>
  sh(DOCKER, ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 3_000 }).pipe(
    Effect.map(() => true),
    Effect.catchAll(() => Effect.succeed(false))
  )

export interface ContainerInfo {
  readonly name: string
  readonly state: string // running | exited | created | …
}

export const inspectContainer = (
  name: string
): Effect.Effect<ContainerInfo | undefined, DockerCliError> =>
  sh(DOCKER, ["inspect", "--format", "{{.State.Status}}", name], { timeoutMs: 10_000 }).pipe(
    Effect.map((r) => ({ name, state: r.stdout.trim() })),
    Effect.catchTag("DockerCliError", (e) =>
      e.stderrTail.includes("No such object")
        ? Effect.succeed(undefined)
        : Effect.fail(e)
    )
  )

/** Start an inline container: reuse a stopped `matisa.<name>` if present,
 * else `run -d`. Returns the container name. */
export const inlineRun = (
  projectName: string,
  image: string,
  ports: ReadonlyArray<number>,
  env: Record<string, string>
): Effect.Effect<string, DockerCliError> =>
  Effect.gen(function* () {
    const cname = containerName(projectName)
    const existing = yield* inspectContainer(cname)
    if (existing?.state === "running") return cname
    if (existing !== undefined) {
      yield* sh(DOCKER, ["start", cname], { timeoutMs: 60_000 })
      return cname
    }
    const portArgs = ports.flatMap((p) => ["-p", `${p}:${p}`])
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`])
    yield* sh(
      DOCKER,
      ["run", "-d", "--name", cname, "--restart", "unless-stopped", ...portArgs, ...envArgs, image],
      { timeoutMs: 300_000 }
    )
    return cname
  })

/** Host pid of the container's init process (for status parity). */
export const inspectPid = (name: string): Effect.Effect<number | undefined, DockerCliError> =>
  sh(DOCKER, ["inspect", "--format", "{{.State.Pid}}", name], { timeoutMs: 10_000 }).pipe(
    Effect.map((r) => {
      const pid = Number(r.stdout.trim())
      return Number.isFinite(pid) && pid > 0 ? pid : undefined
    }),
    Effect.catchAll(() => Effect.succeed(undefined))
  )

/** Last lines of a container's logs — crash tails for docker projects. */
export const containerLogTail = (name: string, lines: number): Effect.Effect<string> =>
  sh(DOCKER, ["logs", "--tail", String(lines), name], { timeoutMs: 10_000 }).pipe(
    Effect.map((r) => (r.stdout + r.stderr).trim()),
    Effect.catchAll(() => Effect.succeed(""))
  )

/** Last lines of a stack's merged logs, service prefixes intact (logs.tail). */
export const composeLogTail = (file: string, lines: number): Effect.Effect<string> =>
  sh(DOCKER, ["compose", "-f", file, "logs", "--tail", String(lines)], { timeoutMs: 10_000 }).pipe(
    Effect.map((r) => (r.stdout + r.stderr).trim()),
    Effect.catchAll(() => Effect.succeed(""))
  )

// ── teardown ────────────────────────────────────────────────────────────────
//
// `docker stop` is itself graceful: SIGTERM, then the daemon's own SIGKILL
// after -t seconds. The CLI timeout must therefore sit ABOVE that grace, or it
// kills the client mid-stop and we report a container down that is still up.
// Both paths escalate rather than give up: a stop that fails or overruns is
// followed by a kill, because the alternative is state that lies.

const STOP_CLI_TIMEOUT_MS = (DOCKER_STOP_GRACE_S + 20) * 1_000

export const inlineStop = (projectName: string): Effect.Effect<void, DockerCliError> =>
  sh(DOCKER, ["stop", "-t", String(DOCKER_STOP_GRACE_S), containerName(projectName)], {
    timeoutMs: STOP_CLI_TIMEOUT_MS
  }).pipe(Effect.asVoid)

/** Stop the container, or kill it. Fails only if BOTH refuse — and then it says
 *  so, rather than being swallowed into a confident `idle`. */
export const inlineStopHard = (projectName: string): Effect.Effect<void, DockerCliError> =>
  inlineStop(projectName).pipe(
    Effect.catchTag("DockerCliError", (e) =>
      Effect.logWarning(
        `docker stop ${containerName(projectName)} failed (${e.stderrTail || "timed out"}) — escalating to kill`
      ).pipe(
        Effect.andThen(
          sh(DOCKER, ["kill", containerName(projectName)], { timeoutMs: 20_000 }).pipe(Effect.asVoid)
        )
      )
    )
  )

export const inlineRemove = (projectName: string): Effect.Effect<void, DockerCliError> =>
  sh(DOCKER, ["rm", "-f", containerName(projectName)], { timeoutMs: 60_000 }).pipe(Effect.asVoid)

// —— compose (whole-stack) ——

export const composeUp = (file: string): Effect.Effect<void, DockerCliError> =>
  sh(DOCKER, ["compose", "-f", file, "up", "-d"], { cwd: dirname(file), timeoutMs: 300_000 }).pipe(
    Effect.asVoid
  )

export const composeDown = (file: string): Effect.Effect<void, DockerCliError> =>
  sh(DOCKER, ["compose", "-f", file, "down", "-t", String(DOCKER_STOP_GRACE_S)], {
    cwd: dirname(file),
    timeoutMs: 300_000
  }).pipe(Effect.asVoid)

/** Take the stack down, or tear it down. A big stack can legitimately outrun a
 *  graceful `down`; killing first makes the second attempt bounded and certain,
 *  so the engine never reports a stack stopped while containers are still up. */
export const composeDownHard = (file: string): Effect.Effect<void, DockerCliError> =>
  composeDown(file).pipe(
    Effect.catchTag("DockerCliError", (e) =>
      Effect.logWarning(
        `docker compose down (${file}) failed (${e.stderrTail || "timed out"}) — escalating to kill`
      ).pipe(
        Effect.andThen(
          sh(DOCKER, ["compose", "-f", file, "kill"], { cwd: dirname(file), timeoutMs: 60_000 }).pipe(
            Effect.catchAll(() => Effect.void)
          )
        ),
        Effect.andThen(
          sh(DOCKER, ["compose", "-f", file, "down", "-t", "0"], {
            cwd: dirname(file),
            timeoutMs: 60_000
          }).pipe(Effect.asVoid)
        )
      )
    )
  )
