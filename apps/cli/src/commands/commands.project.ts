import { Args, Command, Options } from "@effect/cli"
import { Effect, Option, ParseResult, Schema } from "effect"
import { GroupSlug, tokenize } from "@matisa/core"
import type { Command as CoreCommand, NewProject, Port, ProjectPatch } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"
import { resolveProject, resolveProjectRow } from "../cli.resolve.js"

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

// Kind is derived from the flags: --image → docker, --compose → compose,
// otherwise process (which requires --cmd). The engine's Schema enforces the
// same rule, so a bad combination fails loud with the exact message.
const add = Command.make(
  "add",
  {
    name: Options.text("name"),
    dir: Options.text("dir"),
    cmd: Options.optional(cmdOption("cmd")),
    image: Options.optional(Options.text("image")),
    compose: Options.optional(Options.text("compose")),
    group: Options.optional(Options.text("group")),
    icon: Options.optional(Options.text("icon")),
    noStableUrl: Options.boolean("no-stable-url").pipe(
      Options.withDefault(false),
      Options.withDescription(
    "Do not give this project a http://<name>.localhost:<caddy-port> hostname. Its own http://localhost:<port> is unaffected — this only skips the Caddy route. LAN sharing is a separate switch."
  )
    ),
    port: portOption("port")
  },
  ({ cmd, compose, dir, group, icon, image, name, noStableUrl, port }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const kind = Option.isSome(image) ? "docker" : Option.isSome(compose) ? "compose" : "process"
      const input: NewProject = {
        name,
        root: dir,
        kind,
        ...(Option.isSome(cmd) ? { command: buildCommand(name, cmd.value, dir) } : {}),
        ...(Option.isSome(image) ? { image: image.value } : {}),
        ...(Option.isSome(compose) ? { composeFile: compose.value } : {}),
        ...(Option.isSome(group) ? { groupSlug: GroupSlug.make(group.value) } : {}),
        ...(Option.isSome(icon) ? { pathToIcon: icon.value } : {}),
        // Decided here rather than switched off afterwards: a project created
        // exposed and corrected a second later has already been published.
        ...(noStableUrl ? { stableUrl: false } : {}),
        ports: toPorts(port)
      } as NewProject
      const created = yield* call("catalog.add", input)
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
    image: Options.optional(Options.text("image")),
    compose: Options.optional(Options.text("compose")),
    group: Options.optional(Options.text("group")),
    icon: Options.optional(Options.text("icon")),
    port: portOption("port"),
    noPorts: Options.boolean("no-ports").pipe(Options.withDefault(false)),
    // A pair rather than one flag: a patch has to be able to say "turn it back
    // on" as well as "turn it off", and omitting both must leave it alone.
    stableUrl: Options.boolean("stable-url").pipe(
      Options.withDefault(false),
      Options.withDescription("Give this project its Caddy hostname back")
    ),
    noStableUrl: Options.boolean("no-stable-url").pipe(
      Options.withDefault(false),
      Options.withDescription(
        "Stop publishing this project at http://<name>.localhost:<caddy-port>. Its own http://localhost:<port> is unaffected."
      )
    )
  },
  ({ cmd, compose, dir, group, icon, id, image, name, noPorts, noStableUrl, port, stableUrl }) =>
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
        ...(Option.isSome(image) ? { image: image.value } : {}),
        ...(Option.isSome(compose) ? { composeFile: compose.value } : {}),
        ...(Option.isSome(group)
          ? { groupSlug: group.value === "" ? null : GroupSlug.make(group.value) }
          : {}),
        // An empty --icon is how you take one away; omitting the flag leaves it
        // alone. The patch field is nullable for exactly this reason.
        ...(Option.isSome(icon) ? { pathToIcon: icon.value === "" ? null : icon.value } : {}),
        // Ports were unclearable: `--port` with nothing to give it is
        // indistinguishable from not passing it at all, so a project that had
        // moved off a port kept claiming it — and the claim is global, so it
        // also kept every OTHER project off it. `--no-ports` is the empty list
        // said out loud.
        ...(noPorts ? { ports: [] } : port.length > 0 ? { ports: toPorts(port) } : {}),
        // --no-stable-url wins if both are passed: the flag that takes an
        // exposure AWAY is the safer reading of a contradictory instruction.
        ...(noStableUrl ? { stableUrl: false } : stableUrl ? { stableUrl: true } : {})
      }
      const updated = yield* call("catalog.update", {
        id: yield* resolveProject(id),
        patch
      })
      yield* render.project(updated)
    })
)

// project path <id> [--reveal] — where the project lives.
//
// Prints the root and NOTHING else, because the shell is the consumer:
// `cd $(matisa project path web)` is the thing this is for, and a label or a
// trailing summary would end up in the argument. `--reveal` hands the same path
// to the file manager, which was the one desktop affordance with no headless
// counterpart. Reveal is macOS-only in the engine and says so itself.
const path = Command.make(
  "path",
  {
    id: Args.text({ name: "id" }),
    reveal: Options.boolean("reveal").pipe(
      Options.withDescription("Also open the project's folder in the file manager")
    )
  },
  ({ id, reveal }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const project = yield* resolveProjectRow(id)
      if (reveal) yield* call("fs.reveal", { path: project.root })
      yield* render.raw(
        { id: project.id, root: project.root, ...(reveal ? { revealed: true } : {}) },
        project.root
      )
    })
)

const rm = Command.make("rm", { id: Args.text({ name: "id" }) }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    yield* call("catalog.remove", { id: yield* resolveProject(id) })
    yield* render.removed(id)
  })
)

export const project = Command.make("project").pipe(
  Command.withSubcommands([add, list, update, path, rm])
)
