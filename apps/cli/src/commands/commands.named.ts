import { Args, Command, Options } from "@effect/cli"
import { Effect, Option, ParseResult, Schema } from "effect"
import { ProjectId, type CommandVar, type NamedCommand } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { runCommand } from "../transport/transport.pty.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// Named commands: ad-hoc per-project tasks with their own env overrides.
//   matisa commands set <project> <name> --cmd "jest --watch" --var KEY=VAL
//   matisa run <project> <name>       ← interactive PTY session
// A command's vars are its own and are injected on every run of it (layer 4 of
// the precedence), so --var takes KEY=VAL and nothing else.

const VarSpec = Schema.transformOrFail(Schema.String, Schema.Unknown, {
  strict: true,
  decode: (raw, _, ast) => {
    const eq = raw.indexOf("=")
    if (eq <= 0) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "expected KEY=VAL"))
    }
    const v: CommandVar = { key: raw.slice(0, eq), value: raw.slice(eq + 1) }
    return ParseResult.succeed(v)
  },
  encode: () => ParseResult.fail(new ParseResult.Forbidden(undefined as never, "one-way"))
})

const varOption = Options.repeated(Options.text("var")).pipe(
  Options.withSchema(Schema.mutable(Schema.Array(VarSpec)))
)

const fmtCommand = (c: NamedCommand): string => {
  const vars = c.vars.map((v) => `${v.key}=${v.value}`).join(" ")
  return `${c.projectId}  ${c.name}  "${c.command}"${vars === "" ? "" : `  [${vars}]`}`
}

const set = Command.make(
  "set",
  {
    project: Args.text({ name: "project" }),
    name: Args.text({ name: "name" }),
    cmd: Options.text("cmd"),
    vars: varOption
  },
  ({ cmd, name, project, vars }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const saved = yield* call("commands.set", {
        projectId: ProjectId.make(project),
        name,
        command: cmd,
        vars: vars as ReadonlyArray<CommandVar>
      })
      yield* render.raw(saved, fmtCommand(saved))
    })
)

const list = Command.make("list", { project: Args.text({ name: "project" }) }, ({ project }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const rows = yield* call("commands.list", { id: ProjectId.make(project) })
    yield* render.raw(rows, rows.length === 0 ? "no commands" : rows.map(fmtCommand).join("\n"))
  })
)

const rm = Command.make(
  "rm",
  { project: Args.text({ name: "project" }), name: Args.text({ name: "name" }) },
  ({ name, project }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      yield* call("commands.remove", { projectId: ProjectId.make(project), name })
      yield* render.raw({ removed: name }, `removed  ${name}`)
    })
)

export const commandsGroup = Command.make("commands").pipe(
  Command.withSubcommands([set, list, rm])
)

/** Top-level `matisa run <project> <name>` — the old app's one-click task. */
export const run = Command.make(
  "run",
  {
    project: Args.text({ name: "project" }),
    name: Args.text({ name: "name" })
  },
  ({ name, project }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      yield* runCommand(
        project,
        name,
        process.stdout.columns ?? 80,
        process.stdout.rows ?? 24
      )
    })
)
