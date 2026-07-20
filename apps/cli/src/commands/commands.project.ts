import { Args, Command, Options } from "@effect/cli"
import { Effect, Option, ParseResult, Schema } from "effect"
import { ProjectId } from "@matisa/core"
import type { Command as CoreCommand, Port, ProjectPatch } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// project add|list|update|rm — args map to catalog.* control calls. The
// strict-port guard and all validation live in the engine; these handlers only
// marshal and render. The two schemas below are marshalling, not business
// rules: they turn raw flag text into the wire shapes the engine validates.

// Options.repeated(Options.integer(...)) mis-parses valid integers in
// @effect/cli 0.76.x ("'4123' is not a integer"), so repeat the option as text
// and decode the collected array with Schema instead.
const portOption = (name: string) =>
  Options.repeated(Options.text(name)).pipe(
    Options.withSchema(
      // mutable(): Options.repeated hands over string[], not readonly string[]
      Schema.mutable(
        Schema.Array(
          Schema.NumberFromString.pipe(
            Schema.int({ message: () => "port must be an integer" }),
            Schema.between(1, 65535, { message: () => "port must be between 1 and 65535" })
          )
        )
      )
    )
  )

// POSIX-ish tokenizer for --cmd: single quotes are literal, double quotes
// group with \" \\ \$ \` escapes, bare backslash escapes the next char.
// Splitting on whitespace alone mangled anything like `node -e 'setInterval(…)'`.
const tokenize = (input: string): ReadonlyArray<string> | null => {
  const out: Array<string> = []
  let cur = ""
  let started = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      else cur += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === "\\" && i + 1 < input.length && '"\\$`'.includes(input[i + 1]!)) cur += input[++i]!
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i]!
      started = true
    } else if (/\s/.test(ch)) {
      if (started) {
        out.push(cur)
        cur = ""
        started = false
      }
    } else {
      cur += ch
      started = true
    }
  }
  if (quote !== null) return null // unterminated quote
  if (started) out.push(cur)
  return out
}

// Decoding at the option boundary makes a bad --cmd a CLI validation failure
// (usage, exit 4) instead of a mangled child spawned by the engine.
const CmdTokens = Schema.transformOrFail(
  Schema.String,
  Schema.NonEmptyArray(Schema.String),
  {
    strict: true,
    decode: (raw, _, ast) => {
      const tokens = tokenize(raw)
      if (tokens === null)
        return ParseResult.fail(new ParseResult.Type(ast, raw, "unterminated quote in --cmd"))
      if (tokens.length === 0)
        return ParseResult.fail(new ParseResult.Type(ast, raw, "--cmd must contain a program"))
      return ParseResult.succeed(tokens as readonly [string, ...Array<string>])
    },
    encode: (tokens) => ParseResult.succeed(tokens.join(" "))
  }
)

const cmdOption = (name: string) => Options.text(name).pipe(Options.withSchema(CmdTokens))

const buildCommand = (
  name: string,
  [program, ...args]: readonly [string, ...Array<string>],
  cwd?: string
): CoreCommand => ({ name, program, args, ...(cwd === undefined ? {} : { cwd }) })

const toPorts = (nums: ReadonlyArray<number>): ReadonlyArray<Port> =>
  nums.map((number) => ({ number, protocol: "tcp" as const }))

const add = Command.make(
  "add",
  {
    name: Options.text("name"),
    dir: Options.text("dir"),
    cmd: cmdOption("cmd"),
    port: portOption("port")
  },
  ({ cmd, dir, name, port }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const created = yield* call("catalog.add", {
        name,
        root: dir,
        command: buildCommand(name, cmd, dir),
        ports: toPorts(port)
      })
      yield* render.project(created)
    })
)

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const rows = yield* call("catalog.list", undefined)
    yield* render.projects(rows)
  })
)

const update = Command.make(
  "update",
  {
    id: Args.text({ name: "id" }),
    name: Options.optional(Options.text("name")),
    dir: Options.optional(Options.text("dir")),
    cmd: Options.optional(cmdOption("cmd")),
    port: portOption("port")
  },
  ({ cmd, dir, id, name, port }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const cmdName = Option.getOrElse(name, () => "start")
      const patch: ProjectPatch = {
        ...(Option.isSome(name) ? { name: name.value } : {}),
        ...(Option.isSome(dir) ? { root: dir.value } : {}),
        ...(Option.isSome(cmd)
          ? { command: buildCommand(cmdName, cmd.value, Option.getOrUndefined(dir)) }
          : {}),
        ...(port.length > 0 ? { ports: toPorts(port) } : {})
      }
      const updated = yield* call("catalog.update", {
        id: ProjectId.make(id),
        patch
      })
      yield* render.project(updated)
    })
)

const rm = Command.make("rm", { id: Args.text({ name: "id" }) }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    yield* call("catalog.remove", { id: ProjectId.make(id) })
    yield* render.removed(id)
  })
)

export const project = Command.make("project").pipe(
  Command.withSubcommands([add, list, update, rm])
)
