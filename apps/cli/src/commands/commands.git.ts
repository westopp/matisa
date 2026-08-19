import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import type { GitActionResult, GitContext } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"
import { resolveProject } from "../cli.resolve.js"

// git status | branches | fetch | pull | checkout — the same five the desktop
// has, because a client that can see something the other cannot is how the two
// surfaces start drifting.
//
// The scope is the module's, not this file's: no staging, no committing, no
// merging, and pull is fast-forward only. Every failure comes back as a result
// carrying git's own words, so the CLI prints what git said and exits non-zero
// rather than paraphrasing it into something an agent then has to guess at.

const idArg = Args.text({ name: "project" })
const branchArg = Args.text({ name: "branch" })

const dirtyOpt = Options.boolean("dirty").pipe(
  Options.withDescription("Also report whether the working tree has uncommitted changes (costs a scan)")
)

/** One line that says where the checkout is standing. */
const describe = (c: GitContext): string => {
  if (c.repoRoot === undefined) return "not inside a git repository"
  const where = c.branch ?? (c.head === undefined ? "detached" : `detached at ${c.head}`)
  const counts =
    c.ahead === undefined || c.behind === undefined
      ? " (no upstream)"
      : c.ahead === 0 && c.behind === 0
        ? ""
        : ` (${c.ahead} ahead, ${c.behind} behind)`
  const dirty = c.dirty === undefined ? "" : c.dirty ? " · dirty" : " · clean"
  return `${where}${counts}${dirty}\nrepo ${c.repoRoot}`
}

const status = Command.make("status", { id: idArg, dirty: dirtyOpt }, ({ id, dirty }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const projectId = yield* resolveProject(id)
    const context = yield* call("git.context", { id: projectId, dirty })
    yield* render.raw(context, describe(context))
  })
).pipe(Command.withDescription("Print the branch this project's checkout is standing on"))

const branches = Command.make("branches", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const projectId = yield* resolveProject(id)
    const b = yield* call("git.branches", { id: projectId })
    yield* render.raw(
      b,
      b.local.length === 0
        ? "no local branches"
        : b.local.map((name) => `${name === b.current ? "*" : " "} ${name}`).join("\n")
    )
  })
).pipe(Command.withDescription("List the repository's local branches"))

/** git refusing is an ORDINARY outcome, not a crash — but it is still a
 *  failure, and a script that pulled and got exit 0 on "would not fast-forward"
 *  would carry on as though it had the new code. Print what git said, then
 *  exit non-zero. */
const report = (result: GitActionResult): Effect.Effect<void, never, Renderer> =>
  Effect.gen(function* () {
    const render = yield* Renderer
    yield* render.raw(result, `${result.ok ? "" : "failed: "}${result.message}\n${describe(result.context)}`)
    if (!result.ok) yield* Effect.die(new Error(result.message))
  })

const fetch = Command.make("fetch", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const projectId = yield* resolveProject(id)
    yield* report(yield* call("git.fetch", { id: projectId }))
  })
).pipe(Command.withDescription("Fetch the remote refs — touches nothing else"))

const pull = Command.make("pull", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const projectId = yield* resolveProject(id)
    yield* report(yield* call("git.pull", { id: projectId }))
  })
).pipe(Command.withDescription("Pull, fast-forward only — never merges, never leaves a conflict"))

const checkout = Command.make("checkout", { id: idArg, branch: branchArg }, ({ id, branch }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const projectId = yield* resolveProject(id)
    yield* report(yield* call("git.checkout", { id: projectId, branch }))
  })
).pipe(
  Command.withDescription(
    "Switch branch — moves EVERY project sharing this repository, not just this one"
  )
)

export const git = Command.make("git").pipe(
  Command.withSubcommands([status, branches, fetch, pull, checkout]),
  Command.withDescription("Read the branch, and fetch / pull / switch it")
)
