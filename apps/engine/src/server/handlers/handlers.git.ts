import type { ById, GitCheckoutParams, GitStatusParams } from "@matisa/core"
import type { GitShape } from "../../modules/git/git.services.js"
import type { Handlers } from "../server.dispatcher.js"

// git.* — read the branch, and the three moves worth not leaving the app for.
// Every one of these reports failure as a result rather than raising: see the
// note at the top of the module.
export const gitHandlers = (
  git: GitShape
): Pick<Handlers, "git.context" | "git.branches" | "git.fetch" | "git.pull" | "git.checkout"> => ({
  "git.context": (params) => {
    const p = params as GitStatusParams
    return git.context(p.id, p.dirty)
  },
  "git.branches": (params) => git.branches((params as ById).id),
  "git.fetch": (params) => git.fetch((params as ById).id),
  "git.pull": (params) => git.pull((params as ById).id),
  "git.checkout": (params) => {
    const p = params as GitCheckoutParams
    return git.checkout(p.id, p.branch)
  }
})
