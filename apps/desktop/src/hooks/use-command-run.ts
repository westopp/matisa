import { useCallback, useState } from "react"
import type { ProjectId, RuntimeState } from "@matisa/core"
import { closeSession, expectSelfBridged, sendInput, SIGINT_SEQUENCE } from "~/rpc/rpc.pty"
import { useEngine } from "~/store/store.engine"
import { commandPaneId, useTerminals } from "~/store/store.terminals"

// ────────────────────────────────────────────────────────────────────────────
// Running a named command, in one place. Two surfaces reach for it — the
// terminal bar and the commands table — and they must agree on what "running"
// means, otherwise the table's stop button could be offered for a session the
// bar already considers dead.
//
// Truth is the PANE: a command is running when its pane holds a live session
// the engine has not reported an exit for. `starting` is local, and covers only
// the round-trip of commands.run.
// ────────────────────────────────────────────────────────────────────────────

export type CommandStatus = "idle" | "starting" | "running"

export interface CommandRunner {
  readonly statusOf: (name: string) => CommandStatus
  /** The same three states in the vocabulary the rest of the app speaks, plus
   *  the one `CommandStatus` cannot express: a command that ended badly. Every
   *  surface that draws a command — the pill on the board, its terminal's own
   *  header — asks this, so the pill and the pane it summarises can never
   *  disagree about what happened. */
  readonly stateOf: (name: string) => RuntimeState
  readonly run: (name: string, command: string) => Promise<void>
  /** Ctrl-C, the same interrupt the pane's own stop button sends. */
  readonly stop: (name: string) => void
  /** End it now: tear the session down rather than asking the process to leave.
   *  The pane is marked exited here instead of waiting to be told, because
   *  `pty.close` emits no `pty.exit` — there is nothing left to emit one — and a
   *  pane that believed it was still running could never be closed. */
  readonly kill: (name: string) => void
}

export const useCommandRunner = (projectId: ProjectId): CommandRunner => {
  const runCommand = useEngine((s) => s.runCommand)
  const openPane = useTerminals((s) => s.openPane)
  const bindSession = useTerminals((s) => s.bindSession)
  const panes = useTerminals((s) => s.panes)
  const markExited = useTerminals((s) => s.markExited)
  const [starting, setStarting] = useState<ReadonlyArray<string>>([])

  const statusOf = useCallback(
    (name: string): CommandStatus => {
      if (starting.includes(name)) return "starting"
      const pane = panes[commandPaneId(projectId, name)]
      return pane !== undefined && pane.sessionId !== null && !pane.exited ? "running" : "idle"
    },
    [panes, projectId, starting]
  )

  // Broken is decided the way the terminal's own exit badge decides it: a clean
  // 0 is done, and anything else — a code, or a signal that left no code at all
  // — is a failure. One rule, so the badge and the pill cannot contradict each
  // other over the same exit.
  const stateOf = useCallback(
    (name: string): RuntimeState => {
      const status = statusOf(name)
      if (status === "running") return "running"
      if (status === "starting") return "starting"
      const pane = panes[commandPaneId(projectId, name)]
      return pane?.exited === true && pane.exitCode !== 0 ? "crashed" : "idle"
    },
    [panes, projectId, statusOf]
  )

  const run = useCallback(
    async (name: string, command: string): Promise<void> => {
      setStarting((s) => (s.includes(name) ? s : [...s, name]))
      try {
        // Geometry is provisional — the pane re-negotiates it via pty.resize as
        // soon as xterm has measured its container.
        const session = await runCommand({ projectId, name, cols: 120, rows: 32 })
        if (session === null) return

        // The engine bridged this session as part of the call — claim it so the
        // pane subscribes instead of attaching a second pump.
        expectSelfBridged(session.sessionId)

        const paneId = commandPaneId(projectId, name)
        openPane({
          paneId,
          projectId,
          kind: "command",
          title: name,
          subtitle: command,
          sessionId: session.sessionId,
          commandName: name
        })
        bindSession(paneId, session.sessionId)
      } finally {
        setStarting((s) => s.filter((n) => n !== name))
      }
    },
    [bindSession, openPane, projectId, runCommand]
  )

  const stop = useCallback(
    (name: string): void => {
      const pane = panes[commandPaneId(projectId, name)]
      if (pane?.sessionId != null) sendInput(pane.sessionId, SIGINT_SEQUENCE)
    },
    [panes, projectId]
  )

  const kill = useCallback(
    (name: string): void => {
      const sessionId = panes[commandPaneId(projectId, name)]?.sessionId
      if (sessionId == null) return
      closeSession(sessionId)
      markExited(sessionId, null)
    },
    [markExited, panes, projectId]
  )

  return { statusOf, stateOf, run, stop, kill }
}
