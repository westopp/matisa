import { Args, Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { GroupSlug, type Group } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// Groups: standalone organizational buckets; projects join via
// `project add/update --group <slug>` (empty string clears).

const fmtGroup = (g: Group): string =>
  `${g.slug}  ${g.title}${g.description === undefined ? "" : `  — ${g.description}`}${
    g.pathToIcon === undefined ? "" : `  icon=${g.pathToIcon}`
  }`

const set = Command.make(
  "set",
  {
    slug: Args.text({ name: "slug" }),
    title: Options.text("title"),
    description: Options.optional(Options.text("description")),
    notes: Options.optional(Options.text("notes")),
    icon: Options.optional(Options.text("icon"))
  },
  ({ description, icon, notes, slug, title }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer
      const saved = yield* call("groups.set", {
        slug: GroupSlug.make(slug),
        title,
        description: Option.getOrUndefined(description),
        notes: Option.getOrUndefined(notes),
        pathToIcon: Option.getOrUndefined(icon)
      })
      yield* render.raw(saved, fmtGroup(saved))
    })
)

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const rows = yield* call("groups.list", undefined)
    yield* render.raw(rows, rows.length === 0 ? "no groups" : rows.map(fmtGroup).join("\n"))
  })
)

const rm = Command.make("rm", { slug: Args.text({ name: "slug" }) }, ({ slug }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    yield* call("groups.remove", { slug: GroupSlug.make(slug) })
    yield* render.raw({ removed: slug }, `removed  ${slug}`)
  })
)

export const group = Command.make("group").pipe(Command.withSubcommands([set, list, rm]))
