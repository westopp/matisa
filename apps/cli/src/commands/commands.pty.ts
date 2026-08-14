import { Args, Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { SessionId } from "@matisa/core"
import { call, Pty } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"
import { resolveProject } from "../cli.resolve.js"

// sh <project> and logs -f <session> — open an interactive session or attach to
// a run's live output; all raw-mode / resize handling lives in transport.pty.
//
// close and clear are the housekeeping half. A `sh` session outlives the client
// that opened it (that is what makes it reattachable), so without `close` every
// ad-hoc shell the CLI ever opened stayed a live $SHELL on the engine with no
// way to end it headlessly. `clear` drops the recorded scrollback without
// touching the process, which is the only way to shrink a session that has been
// spewing for a week.

const sessionArg = Args.text({ name: "session" })

const sh = Command.make(
  "sh",
  {
    id: Args.text({ name: "project" }),
    cmd: Options.optional(Options.text("cmd")),
    cols: Options.integer("cols").pipe(Options.withDefault(80)),
    rows: Options.integer("rows").pipe(Options.withDefault(24))
  },
  ({ cmd, cols, id, rows }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const projectId = yield* resolveProject(id)
      yield* Pty.open(projectId, Option.getOrUndefined(cmd), cols, rows)
    })
)

const logs = Command.make(
  "logs",
  {
    session: sessionArg,
    follow: Options.boolean("follow").pipe(
      Options.withAlias("f"),
      Options.withDefault(true)
    )
  },
  ({ session }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      yield* Pty.attach(SessionId.make(session))
    })
)

// The engine refuses to close a `run:` session — that process belongs to the
// supervisor, and `lifecycle stop` is the way to end it. The refusal surfaces
// verbatim rather than being pre-empted here, so the message stays in one place.
const close = Command.make("close", { session: sessionArg }, ({ session }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    yield* call("pty.close", { sessionId: SessionId.make(session) })
    yield* render.raw({ sessionId: session, closed: true }, `closed ${session}`)
  })
)

const clear = Command.make("clear", { session: sessionArg }, ({ session }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    yield* call("pty.clear", { sessionId: SessionId.make(session) })
    yield* render.raw({ sessionId: session, cleared: true }, `cleared ${session}`)
  })
)

export const pty = Command.make("pty").pipe(
  Command.withSubcommands([sh, logs, close, clear])
)
