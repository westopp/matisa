import { useEffect } from "react"
import type { NamedCommand, ProjectId } from "@matisa/core"
import { reportError, useEngine } from "~/store/store.engine"

// A project's named commands. Caller-agnostic: it takes the project id it needs
// and returns the list — it knows nothing about which surface consumes it, so
// the terminal bar and the commands card share one fetch instead of two.

const NONE: ReadonlyArray<NamedCommand> = []

export const useProjectCommands = (projectId: ProjectId): ReadonlyArray<NamedCommand> => {
  const loadCommands = useEngine((s) => s.loadCommands)
  // Default OUTSIDE the selector: `?? []` inside one mints a fresh array on
  // every snapshot read, which useSyncExternalStore treats as a changed store.
  const stored = useEngine((s) => s.commands[projectId])

  useEffect(() => {
    void loadCommands(projectId).catch((cause) => reportError(cause, "could not load commands"))
  }, [projectId, loadCommands])

  return stored ?? NONE
}
