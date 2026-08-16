import { Args, Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { homedir } from "node:os"
import { ContextId, ProjectId, type EnvContext, type ProjectWithState } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"
import { readLegacyConfig, type LegacyService } from "../cli.legacy-config.js"

// ────────────────────────────────────────────────────────────────────────────
// `matisa import` — re-derive each project's environments from the pre-engine
// config files.
//
// WHY THIS EXISTS. The original migration into the engine had nowhere to put a
// per-project "dev" and "test", because environments were global and their names
// had to be unique across the whole installation. So it flattened: each project's
// base variables were merged into a context named after the project, and again
// into a second one named `<project>-test`. seethis-server ended up as two
// near-identical 25-key copies where the source had 24 base keys, a 3-key `dev`
// overlay and a 2-key `test` overlay. Migration 0006 fixed the SHAPE — one owner
// per context, one base per project — but it could not recover the split, because
// which key belonged to which layer is only recorded in the source files.
//
// SYNC, NOT MERGE. The config files are the source of truth, so this makes the
// engine match them for every project the config names: base becomes exactly the
// top-level values, one context per overlay holding exactly that overlay's keys,
// and any other context on that project is removed. That is what makes the
// command re-runnable — editing a config file and re-importing converges rather
// than accumulating. Projects the config does not mention are never touched.
//
// Run it with --dry-run first; it prints the same plan without executing it.
// ────────────────────────────────────────────────────────────────────────────

interface ContextPlan {
  readonly name: string
  readonly contextId?: ContextId
  readonly create: boolean
  readonly isBase: boolean
  readonly upserts: ReadonlyArray<{
    readonly key: string
    readonly value: string
    readonly secret: boolean
  }>
  readonly removals: ReadonlyArray<string>
}

interface ProjectPlan {
  readonly projectId: ProjectId
  readonly projectName: string
  readonly contexts: ReadonlyArray<ContextPlan>
  /** Contexts on this project that the config no longer describes — the
   *  flattened `<project>` / `<project>-test` pair, on the first run. */
  readonly drop: ReadonlyArray<{ readonly id: ContextId; readonly name: string }>
  /** Set when the project would be left with no active environment and the
   *  config defines a `dev` — see the note at the call site. */
  readonly activate?: { readonly name: string; readonly contextId?: ContextId }
}

const varsToMap = (
  vars: ReadonlyArray<{ readonly key: string; readonly value: string }>
): ReadonlyMap<string, string> => new Map(vars.map((v) => [v.key, v.value]))

/** What has to change for one context to hold exactly `wanted`. A var already at
 *  the right value is left alone so a re-import is quiet rather than rewriting
 *  every row it has already written.
 *
 *  `secretOf` carries the masking flag across the un-flattening. The config
 *  files have no notion of a secret — that flag is set in the desktop or by
 *  `env set --secret`, and it lives on the row being replaced. Rebuilding a key
 *  from source without it would silently unmask an AWS key in every listing. */
const diff = (
  existing: EnvContext | undefined,
  wanted: ReadonlyArray<{ readonly key: string; readonly value: string }>,
  secretOf: (key: string) => boolean
): Pick<ContextPlan, "upserts" | "removals"> => {
  const have = new Map((existing?.vars ?? []).map((v) => [v.key, v]))
  const want = varsToMap(wanted)
  return {
    upserts: wanted
      .filter((v) => {
        const current = have.get(v.key)
        return current === undefined || current.value !== v.value || current.secret !== secretOf(v.key)
      })
      .map((v) => ({ ...v, secret: secretOf(v.key) })),
    removals: [...have.keys()].filter((k) => !want.has(k))
  }
}

const planFor = (
  service: LegacyService,
  project: ProjectWithState,
  contexts: ReadonlyArray<EnvContext>
): ProjectPlan => {
  const mine = contexts.filter((c) => c.projectId === project.id)
  const base = mine.find((c) => c.isBase)
  const named = mine.filter((c) => !c.isBase)

  // Which keys this project treats as secret, gathered across ALL its contexts:
  // on the first import the flag sits on the flattened context about to be
  // dropped, not on the base the key is moving to.
  const secretKeys = new Set(
    mine.flatMap((c) => c.vars.filter((v) => v.secret).map((v) => v.key))
  )
  const secretOf = (key: string): boolean => secretKeys.has(key)

  const plans: Array<ContextPlan> = [
    {
      name: "base",
      ...(base === undefined ? {} : { contextId: base.id }),
      // 0006 gives every project a base, so this only creates one for a project
      // added by some path that predates it.
      create: base === undefined,
      isBase: true,
      ...diff(base, service.base, secretOf)
    },
    ...service.contexts.map((c): ContextPlan => {
      const existing = named.find((e) => e.name.toLowerCase() === c.name.toLowerCase())
      return {
        name: c.name,
        ...(existing === undefined ? {} : { contextId: existing.id }),
        create: existing === undefined,
        isBase: false,
        ...diff(existing, c.vars, secretOf)
      }
    })
  ]

  const wantedNames = new Set(service.contexts.map((c) => c.name.toLowerCase()))
  const drop = named
    .filter((c) => !wantedNames.has(c.name.toLowerCase()))
    .map((c) => ({ id: c.id, name: c.name }))

  // A project whose active environment is one of the dropped flattened contexts
  // would fall back to base alone, silently losing NODE_ENV and friends. The old
  // app selected a context globally and that selection was `dev` in practice, so
  // that is the intent to preserve — but only when the config actually defines a
  // `dev`, and only when nothing else survives to stay selected.
  const activeSurvives =
    project.activeContextId !== undefined &&
    !drop.some((d) => d.id === project.activeContextId) &&
    named.some((c) => c.id === project.activeContextId)
  const dev = service.contexts.find((c) => c.name.toLowerCase() === "dev")
  const activate =
    activeSurvives || dev === undefined
      ? undefined
      : {
          name: dev.name,
          ...(() => {
            const existing = named.find((e) => e.name.toLowerCase() === "dev")
            return existing === undefined ? {} : { contextId: existing.id }
          })()
        }

  return {
    projectId: project.id,
    projectName: project.name,
    contexts: plans,
    drop,
    ...(activate === undefined ? {} : { activate })
  }
}

const isNoop = (p: ProjectPlan): boolean =>
  p.drop.length === 0 &&
  p.activate === undefined &&
  p.contexts.every((c) => !c.create && c.upserts.length === 0 && c.removals.length === 0)

const describe = (plans: ReadonlyArray<ProjectPlan>, skipped: ReadonlyArray<string>): string => {
  const changing = plans.filter((p) => !isNoop(p))
  const lines: Array<string> = []
  for (const p of changing) {
    lines.push(p.projectName)
    for (const c of p.contexts) {
      const bits = [
        c.create ? "create" : undefined,
        c.upserts.length > 0 ? `${c.upserts.length} set` : undefined,
        c.removals.length > 0 ? `${c.removals.length} removed` : undefined
      ].filter((b) => b !== undefined)
      if (bits.length > 0) lines.push(`  ${c.name}: ${bits.join(", ")}`)
    }
    for (const d of p.drop) lines.push(`  ${d.name}: DROP (not in config)`)
    if (p.activate !== undefined) lines.push(`  → active environment: ${p.activate.name}`)
  }
  if (changing.length === 0) lines.push("nothing to change — the engine already matches the config")
  if (skipped.length > 0) {
    lines.push("", `not in the catalog, skipped: ${skipped.join(", ")}`)
  }
  lines.push(
    "",
    `${changing.length} project(s) to change, ${plans.length - changing.length} already in sync`
  )
  return lines.join("\n")
}

export const importConfig = Command.make(
  "import",
  {
    dir: Args.directory({ name: "config-dir" }).pipe(
      Args.optional
    ),
    project: Options.optional(Options.text("project")),
    dryRun: Options.boolean("dry-run").pipe(Options.withDefault(false))
  },
  ({ dir, dryRun, project }) =>
    Effect.gen(function* () {
      yield* applyGlobals
      const render = yield* Renderer

      const configDir = Option.isSome(dir) ? dir.value : `${homedir()}/.config/matisa`
      const services = yield* readLegacyConfig(configDir)
      const wanted = Option.isSome(project)
        ? services.filter((s) => s.name.toLowerCase() === project.value.toLowerCase())
        : services

      const catalog = yield* call("catalog.list", undefined)
      const byName = new Map(catalog.map((p) => [p.name.toLowerCase(), p]))
      const contexts = yield* call("env.list", undefined)

      const skipped: Array<string> = []
      const plans: Array<ProjectPlan> = []
      for (const service of wanted) {
        const match = byName.get(service.name.toLowerCase())
        if (match === undefined) {
          skipped.push(service.name)
          continue
        }
        plans.push(planFor(service, match, contexts))
      }

      if (dryRun) {
        yield* render.raw({ dryRun: true, plans, skipped }, describe(plans, skipped))
        return
      }

      for (const plan of plans.filter((p) => !isNoop(p))) {
        // Strays go FIRST so their ids are free for the contexts replacing them:
        // dropping `seethis-server-test` before creating this project's `test`
        // is what lets the new one be `seethis-server-test` rather than
        // `seethis-server-test-2`. Losing the active context in between is
        // harmless — the engine reads the environment at spawn, and the
        // re-point below runs before this command returns.
        for (const d of plan.drop) yield* call("env.remove", { contextId: d.id })
        for (const ctx of plan.contexts) {
          const contextId = ctx.create
            ? (yield* call("env.create", { projectId: plan.projectId, name: ctx.name })).id
            : ctx.contextId
          if (contextId === undefined) continue
          for (const v of ctx.upserts) {
            yield* call("env.set", { contextId, key: v.key, value: v.value, secret: v.secret })
          }
          for (const key of ctx.removals) yield* call("env.unset", { contextId, key })
        }
        if (plan.activate !== undefined) {
          // Re-read rather than trust the pre-plan id: the context may have just
          // been created, and `env.create` is the only place its id is minted.
          const now = yield* call("env.list", undefined)
          const target = now.find(
            (c) =>
              c.projectId === plan.projectId &&
              c.name.toLowerCase() === plan.activate!.name.toLowerCase()
          )
          if (target !== undefined) {
            yield* call("env.use", { projectId: plan.projectId, contextId: target.id })
          }
        }
      }

      yield* render.raw({ dryRun: false, plans, skipped }, describe(plans, skipped))
    })
)
