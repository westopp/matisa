import { Args, Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { ProjectId, SessionId, type CrashRecord, type ResourcesSnapshot } from "@matisa/core"
import { spawnEngineAndWait } from "../cli.engine-spawn.js"
import { ClientConfig } from "../config/config.client-config.js"
import { call } from "../transport/transport.index.js"
import { attach } from "../transport/transport.pty.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// engine.* self-management, docker daemon control, logs, failures, resources —
// the old CLI's operational surface, restored.

const engineStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const s = yield* call("engine.status", undefined)
    yield* render.raw(
      s,
      `engine pid=${s.pid} v${s.version} up-since=${new Date(s.startedAt).toISOString()}\n` +
        `socket ${s.socketPath}\ndb     ${s.dbPath}\n` +
        `FULL: ${s.modulesFull.join(", ")} | STUB: ${s.modulesStub.join(", ")}`
    )
  })
)

const engineStop = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const r = yield* call("engine.shutdown", undefined)
    yield* render.raw(r, "engine shutting down")
  })
)

const engineStart = Command.make("start", {}, () =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const config = yield* ClientConfig
    const socketPath = yield* config.socketPath
    const up = yield* spawnEngineAndWait(socketPath)
    yield* render.raw(
      { started: up },
      up ? `engine listening on ${socketPath}` : "engine failed to come up within 15s"
    )
    if (!up) yield* Effect.fail(new Error("engine did not start")).pipe(Effect.orDie)
  })
)

export const engine = Command.make("engine").pipe(
  Command.withSubcommands([engineStatus, engineStart, engineStop])
)

// —— docker daemon ——

const dockerCmd = (name: "status" | "start" | "stop") =>
  Command.make(name, {}, () =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const r = yield* call(`docker.daemon.${name}`, undefined)
      yield* render.raw(r, `docker daemon: ${r.state}${r.message === undefined ? "" : ` (${r.message})`}`)
    })
  )

export const docker = Command.make("docker").pipe(
  Command.withSubcommands([dockerCmd("status"), dockerCmd("start"), dockerCmd("stop")])
)

// —— logs ——

export const logs = Command.make(
  "logs",
  {
    id: Args.text({ name: "id" }),
    lines: Options.integer("lines").pipe(Options.withDefault(200)),
    follow: Options.boolean("follow", { aliases: ["f"] }).pipe(Options.withDefault(false))
  },
  ({ follow, id, lines }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      if (follow) {
        // Live: attach to the run session (scrollback replays first).
        yield* attach(SessionId.make(`run:${id}`))
        return
      }
      const render = yield* Renderer
      const r = yield* call("logs.tail", { projectId: ProjectId.make(id), lines })
      yield* render.raw(r, r.lines.join(""))
    })
)

// —— failures ——

const fmtCrash = (c: CrashRecord): string =>
  `${new Date(c.ts).toISOString()}  ${c.projectId}  ${
    c.signal === undefined ? `exit=${c.exitCode ?? "?"}` : `signal=${c.signal}`
  }${c.summary === undefined ? "" : `\n  ${c.summary}`}`

export const failures = Command.make(
  "failures",
  {
    project: Args.text({ name: "project" }).pipe(Args.optional),
    limit: Options.integer("limit").pipe(Options.withDefault(20))
  },
  ({ limit, project }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const rows = yield* call("lifecycle.failures", {
        projectId: Option.map(project, ProjectId.make).pipe(Option.getOrUndefined),
        limit
      })
      yield* render.raw(rows, rows.length === 0 ? "no recorded failures" : rows.map(fmtCrash).join("\n"))
    })
)

// —— resources ——

const fmtResources = (r: ResourcesSnapshot): string =>
  r.samples.length === 0
    ? "nothing running"
    : r.samples
        .map(
          (s) =>
            `${s.projectId}  cpu=${s.cpuPercent.toFixed(1)}%  rss=${(s.rssBytes / (1024 * 1024)).toFixed(1)}MiB${
              s.pid === undefined ? "" : `  pid=${s.pid}`
            }`
        )
        .join("\n")

export const resources = Command.make("resources", {}, () =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const r = yield* call("resources.snapshot", undefined)
    yield* render.raw(r, fmtResources(r))
  })
)
