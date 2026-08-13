import { Effect } from "effect"
import type { LogsTailParams } from "@matisa/core"
import type { AppConfigShape } from "../../config/config.app-config.js"
import { ENGINE_VERSION } from "../../config/config.constants.js"
import type { CatalogShape } from "../../modules/catalog/catalog.services.js"
import { composeLogTail, containerLogTail, containerName } from "../../modules/docker/docker.actions.js"
import type { DockerDaemonShape } from "../../modules/docker/docker.daemon.js"
import type { PtyManagerShape } from "../../modules/pty/pty.services.js"
import type { ResourcesShape } from "../../modules/resources/resources.services.js"
import type { SupervisorShape } from "../../modules/supervisor/supervisor.services.js"
import type { Handlers } from "../server.dispatcher.js"

// engine.* self-management, docker daemon control, logs.tail, resources.
// `engine.shutdown` acks first, then raises SIGTERM on the next tick so the
// response flushes before graceful Scope teardown begins.

export const engineHandlers = (
  config: AppConfigShape,
  startedAt: number,
  daemon: DockerDaemonShape,
  resources: ResourcesShape,
  catalog: CatalogShape,
  supervisor: SupervisorShape,
  pty: PtyManagerShape
): Pick<
  Handlers,
  | "engine.status"
  | "engine.shutdown"
  | "docker.daemon.status"
  | "docker.daemon.start"
  | "docker.daemon.stop"
  | "logs.tail"
  | "resources.snapshot"
> => ({
  "engine.status": () =>
    Effect.succeed({
      pid: process.pid,
      version: ENGINE_VERSION,
      startedAt,
      socketPath: config.socketPath,
      dbPath: config.dbPath,
      modulesFull: ["catalog", "supervisor", "events", "pty", "docker", "commands", "groups", "resources", "exposure", "discovery"],
      modulesStub: []
    }),
  "engine.shutdown": () =>
    Effect.sync(() => {
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 50)
      return { accepted: true }
    }),
  "docker.daemon.status": () => daemon.status(),
  "docker.daemon.start": () => daemon.start(),
  "docker.daemon.stop": () => daemon.stop(),
  // Tails come from the SOURCE, not a copy: docker's own log store for
  // containers and stacks, PTY scrollback for processes. log_line events are
  // broadcast-only, so there is no durable copy to read back — by design.
  "logs.tail": (params) => {
    const p = params as LogsTailParams
    const split = (raw: string): { lines: ReadonlyArray<string> } => ({
      lines: raw === "" ? [] : raw.split("\n")
    })
    return catalog.list().pipe(
      Effect.map((projects) => projects.find((pr) => pr.id === p.projectId)),
      Effect.flatMap((project) => {
        if (project === undefined) return Effect.succeed(split(""))
        if (project.kind === "docker") {
          return containerLogTail(containerName(project.name), p.lines).pipe(Effect.map(split))
        }
        if (project.kind === "compose") {
          return composeLogTail(project.composeFile ?? "", p.lines).pipe(Effect.map(split))
        }
        // process: the run session's scrollback, when one exists.
        return supervisor.status(p.projectId).pipe(
          Effect.flatMap((s) =>
            s.sessionId === undefined
              ? Effect.succeed(split(""))
              : pty.scrollbackTail(s.sessionId, p.lines).pipe(Effect.map(split))
          )
        )
      }),
      Effect.orDie
    )
  },
  "resources.snapshot": () => resources.snapshot()
})
