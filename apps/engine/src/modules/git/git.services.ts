import { execFile } from "node:child_process"
import { Context, Effect, Layer } from "effect"
import type {
  GitActionResult,
  GitBranches,
  GitContext as GitContextResult,
  ProjectId
} from "@matisa/core"
import { ProjectsRepo } from "@matisa/store"

// ────────────────────────────────────────────────────────────────────────────
// git — where a project's checkout is standing, and the three moves that are
// annoying to leave the app for.
//
// Scope is the point of this module. It reads a branch and an ahead/behind
// count, and it runs fetch, pull and checkout. It does not stage, commit,
// stash, merge, resolve, or reason about what git did. Anything that can
// conflict is git's business and the user's terminal's.
//
// So every failure here is a RESULT, not an error: `{ ok: false, message }`
// carrying git's own stderr, verbatim. A checkout refused because the tree is
// dirty is the ordinary case — the user knows exactly what that means and what
// to do about it, and a paraphrase would only make it harder to act on.
//
// A project whose root is not in a repository is likewise not an error. It is
// most of the answer to "should this card show a branch": no.
// ────────────────────────────────────────────────────────────────────────────

interface Run {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

/** Never rejects. Timeouts are short because everything here is local plumbing
 *  — except fetch and pull, which the callers below give their own budget. */
const git = (cwd: string, args: ReadonlyArray<string>, timeoutMs = 5_000): Effect.Effect<Run> =>
  Effect.async<Run>((resume) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        // Keep git from ever stopping on a prompt: a credential helper waiting
        // on stdin inside a daemon would hang the call until the timeout, and
        // "it went quiet for 30 seconds" is the worst way to report a fetch
        // that needed a password.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }
      },
      (err, stdout, stderr) =>
        resume(Effect.succeed({ ok: err === null, stdout: stdout.trim(), stderr: stderr.trim() }))
    )
    return Effect.sync(() => {
      child.kill("SIGKILL")
    })
  })

/** git's answer, or its complaint, whichever it gave. Trimmed to a few lines:
 *  this lands in a tooltip, not a terminal. */
const said = (run: Run, fallback: string): string => {
  const text = (run.stderr || run.stdout).trim()
  if (text === "") return fallback
  return text.split("\n").slice(-4).join("\n")
}

export interface GitShape {
  readonly context: (id: ProjectId, dirty?: boolean) => Effect.Effect<GitContextResult>
  readonly branches: (id: ProjectId) => Effect.Effect<GitBranches>
  readonly fetch: (id: ProjectId) => Effect.Effect<GitActionResult>
  readonly pull: (id: ProjectId) => Effect.Effect<GitActionResult>
  readonly checkout: (id: ProjectId, branch: string) => Effect.Effect<GitActionResult>
}

export class Git extends Context.Tag("Git")<Git, GitShape>() {}

export const GitLive = Layer.effect(
  Git,
  Effect.gen(function* () {
    const projects = yield* ProjectsRepo

    /** The project's root, or null if there is no such project. A removed
     *  project is not worth an error path here — the client asked about
     *  something that is gone, and an empty context says so. */
    const rootOf = (id: ProjectId): Effect.Effect<string | null> =>
      projects.get(id).pipe(
        Effect.map((project): string | null => project.root),
        Effect.orElseSucceed(() => null)
      )

    /** Resolve the repository the project sits in. Not the project root: in a
     *  monorepo the project is a subdirectory, and every git command below has
     *  to run against the repo that actually owns it. */
    const repoRootOf = (root: string): Effect.Effect<string | null> =>
      git(root, ["rev-parse", "--show-toplevel"]).pipe(
        Effect.map((r) => (r.ok && r.stdout !== "" ? r.stdout : null))
      )

    const readContext = (
      id: ProjectId,
      root: string,
      repoRoot: string,
      dirty: boolean
    ): Effect.Effect<GitContextResult> =>
      Effect.gen(function* () {
        const [branchRun, headRun] = yield* Effect.all([
          git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
          git(repoRoot, ["rev-parse", "--short", "HEAD"])
        ])

        // "HEAD" from --abbrev-ref means detached: there is no branch to name,
        // and the sha is the only honest thing to show.
        const branch = branchRun.ok && branchRun.stdout !== "HEAD" ? branchRun.stdout : undefined
        const head = headRun.ok && headRun.stdout !== "" ? headRun.stdout : undefined

        // One command for both counts, and it fails outright when the branch
        // tracks nothing — which is exactly the case where neither number
        // exists, so there is nothing to distinguish or report.
        const counts =
          branch === undefined
            ? null
            : yield* git(repoRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).pipe(
                Effect.map((r) => {
                  if (!r.ok) return null
                  const [behind, ahead] = r.stdout.split(/\s+/).map((n) => Number.parseInt(n, 10))
                  return Number.isFinite(behind) && Number.isFinite(ahead)
                    ? { behind: behind as number, ahead: ahead as number }
                    : null
                })
              )

        // Scoped to the project's own directory, not the whole repo: in a
        // monorepo "is my project dirty" is about my project, and reporting a
        // sibling's edits as this card's state would be noise on every card.
        const isDirty = dirty
          ? yield* git(repoRoot, ["status", "--porcelain", "--", root], 10_000).pipe(
              Effect.map((r) => (r.ok ? r.stdout !== "" : false))
            )
          : undefined

        return {
          projectId: id,
          repoRoot,
          ...(branch === undefined ? {} : { branch }),
          ...(head === undefined ? {} : { head }),
          ...(counts === null ? {} : { ahead: counts.ahead, behind: counts.behind }),
          ...(isDirty === undefined ? {} : { dirty: isDirty })
        }
      })

    const context: GitShape["context"] = (id, dirty = false) =>
      Effect.gen(function* () {
        const root = yield* rootOf(id)
        if (root === null) return { projectId: id }
        const repoRoot = yield* repoRootOf(root)
        if (repoRoot === null) return { projectId: id }
        return yield* readContext(id, root, repoRoot, dirty)
      })

    const branches: GitShape["branches"] = (id) =>
      Effect.gen(function* () {
        const root = yield* rootOf(id)
        if (root === null) return { local: [] }
        const repoRoot = yield* repoRootOf(root)
        if (repoRoot === null) return { local: [] }

        const [list, current] = yield* Effect.all([
          git(repoRoot, ["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads"]),
          git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
        ])
        const local = list.ok ? list.stdout.split("\n").filter((b) => b !== "") : []
        const head = current.ok && current.stdout !== "HEAD" ? current.stdout : undefined
        return { local, ...(head === undefined ? {} : { current: head }) }
      })

    /** The shared shape of the three actions: resolve the repo, run the thing,
     *  report what git said, and hand back the state it left behind. */
    const act = (
      id: ProjectId,
      args: ReadonlyArray<string>,
      timeoutMs: number,
      done: string
    ): Effect.Effect<GitActionResult> =>
      Effect.gen(function* () {
        const root = yield* rootOf(id)
        const repoRoot = root === null ? null : yield* repoRootOf(root)
        if (root === null || repoRoot === null) {
          return {
            ok: false,
            message: "this project is not inside a git repository",
            context: { projectId: id }
          }
        }
        const run = yield* git(repoRoot, args, timeoutMs)
        const after = yield* readContext(id, root, repoRoot, false)
        return { ok: run.ok, message: said(run, done), context: after }
      })

    // Network calls, so a much longer budget than the plumbing — but still
    // bounded: an unreachable remote must fail rather than hang a client that
    // is waiting on the answer.
    const fetch: GitShape["fetch"] = (id) =>
      act(id, ["fetch", "--prune"], 45_000, "fetched")

    // Explicitly --ff-only. A pull that can merge is a pull that can leave a
    // conflicted tree behind a button in an app that has no way to help you
    // out of one. If it will not fast-forward, git says so and the user takes
    // it to a terminal.
    const pull: GitShape["pull"] = (id) => act(id, ["pull", "--ff-only"], 60_000, "up to date")

    const checkout: GitShape["checkout"] = (id, branch) =>
      act(id, ["checkout", branch], 30_000, `on ${branch}`)

    return Git.of({ context, branches, fetch, pull, checkout })
  })
)
