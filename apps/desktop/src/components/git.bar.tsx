import { useEffect, useState } from "react"
import type { ProjectId } from "@matisa/core"
import { useEngine } from "~/store/store.engine"
import { rpc } from "~/rpc/rpc.client"
import { Icons } from "./icons"
import { Menu, type MenuItem } from "./menu"

// ────────────────────────────────────────────────────────────────────────────
// Where this project's checkout is standing, and the three moves worth not
// leaving the app for: fetch, pull, switch branch.
//
// Matisa is not becoming a git client. There is no stage, no commit, no merge,
// no conflict resolution — and when git refuses, this says what git said and
// stops. That is the whole contract: shorten three specific errands, and get
// out of the way of everything else.
//
// Read on mount and on window focus, never polled. The case a poll would be
// for — the user switching branch in their own terminal — is a case where they
// come back to this window afterwards, and coming back is a focus event. So the
// reading is fresh exactly when someone is there to read it, and free the rest
// of the time.
//
// One caveat the UI has to be honest about: branch is a property of the REPO,
// and several projects in a monorepo share one. Switching here moves all of
// them, so the switch says so rather than implying this card has its own.
// ────────────────────────────────────────────────────────────────────────────

export const GitBar = ({ projectId, compact = false }: { projectId: ProjectId; compact?: boolean }) => {
  const context = useEngine((s) => s.git[projectId])
  const loadGit = useEngine((s) => s.loadGit)
  const runGit = useEngine((s) => s.runGit)

  const [busy, setBusy] = useState<"fetch" | "pull" | "checkout" | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [branches, setBranches] = useState<ReadonlyArray<string>>([])

  useEffect(() => {
    void loadGit(projectId)
    const onFocus = (): void => void loadGit(projectId)
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [projectId, loadGit])

  // Nothing to say about a project that is not in a repository — and saying
  // "not a git repo" on every card that is not would be noise on most of them.
  if (context?.repoRoot === undefined) return null

  const act = async (action: "fetch" | "pull", label: string): Promise<void> => {
    setBusy(action)
    setSaid(null)
    try {
      const { ok, message } = await runGit(action, projectId)
      // git's own words either way. A refusal here is ordinary — nothing to
      // recover from, just something to read.
      setSaid(ok ? message || label : message)
    } finally {
      setBusy(null)
    }
  }

  const openBranches = async (el: HTMLElement): Promise<void> => {
    setMenu(el)
    try {
      const { local } = await rpc.call("git.branches", { id: projectId })
      setBranches(local)
    } catch {
      setBranches([])
    }
  }

  const switchTo = async (branch: string): Promise<void> => {
    setMenu(null)
    setBusy("checkout")
    setSaid(null)
    try {
      const { ok, message } = await runGit("checkout", projectId, branch)
      setSaid(ok ? `on ${branch}` : message)
    } finally {
      setBusy(null)
    }
  }

  const items: ReadonlyArray<MenuItem> =
    branches.length === 0
      ? [{ key: "none", label: "no other branches", disabled: true, onSelect: () => {} }]
      : branches.map((b) => ({
          key: b,
          label: b,
          icon: b === context.branch ? <Icons.Check size={12} /> : undefined,
          disabled: b === context.branch,
          onSelect: () => void switchTo(b)
        }))

  const label = context.branch ?? (context.head === undefined ? "detached" : `detached @ ${context.head}`)
  const ahead = context.ahead ?? 0
  const behind = context.behind ?? 0

  return (
    <span className={`git-bar ${compact ? "compact" : ""}`} onClick={(e) => e.stopPropagation()}>
      <button
        className="git-branch"
        title={`${label} — switch branch (moves every project in ${context.repoRoot})`}
        disabled={busy !== null}
        onClick={(e) => void openBranches(e.currentTarget)}
      >
        <Icons.Git size={11} />
        <span className="git-branch-name">{label}</span>
        {(ahead > 0 || behind > 0) && (
          <span className="git-counts" title={`${ahead} ahead, ${behind} behind`}>
            {behind > 0 && `↓${behind}`}
            {ahead > 0 && `↑${ahead}`}
          </span>
        )}
      </button>

      {!compact && (
        <>
          <button
            className="ico"
            title="Fetch — update the remote refs, touch nothing else"
            disabled={busy !== null}
            onClick={() => void act("fetch", "fetched")}
          >
            <Icons.ArrowDownCircle size={12} />
          </button>
          <button
            className="ico"
            // Fast-forward only, deliberately: a pull that can merge is a pull
            // that can leave a conflict behind a button in an app with no way
            // to help you out of one.
            title="Pull — fast-forward only"
            disabled={busy !== null}
            onClick={() => void act("pull", "up to date")}
          >
            <Icons.Refresh size={12} />
          </button>
          {said !== null && (
            <span className="git-said" title={said}>
              {said.split("\n")[0]}
            </span>
          )}
        </>
      )}

      {menu !== null && <Menu trigger={menu} items={items} onClose={() => setMenu(null)} />}
    </span>
  )
}
