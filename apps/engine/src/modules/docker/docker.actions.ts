import { Effect } from "effect"
import { dirname } from "node:path"
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

export const inlineStop = (projectName: string): Effect.Effect<void, DockerCliError> =>
  sh(DOCKER, ["stop", containerName(projectName)], { timeoutMs: 60_000 }).pipe(Effect.asVoid)

export const inlineRemove = (projectName: string): Effect.Effect<void, DockerCliError> =>
  sh(DOCKER, ["rm", "-f", containerName(projectName)], { timeoutMs: 60_000 }).pipe(Effect.asVoid)

// —— compose (whole-stack) ——

export const composeUp = (file: string): Effect.Effect<void, DockerCliError> =>
  sh(DOCKER, ["compose", "-f", file, "up", "-d"], { cwd: dirname(file), timeoutMs: 300_000 }).pipe(
    Effect.asVoid
  )

export const composeDown = (file: string): Effect.Effect<void, DockerCliError> =>
  sh(DOCKER, ["compose", "-f", file, "down"], { cwd: dirname(file), timeoutMs: 120_000 }).pipe(
    Effect.asVoid
  )
