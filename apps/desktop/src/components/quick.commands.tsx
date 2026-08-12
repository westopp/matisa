import type { ProjectWithState } from "@matisa/core"
import { useCommandRunner, type CommandRunner } from "~/hooks/use-command-run"
import { useLifecycleState } from "~/hooks/use-lifecycle-state"
import { useProjectCommands } from "~/hooks/use-project-commands"
import { useEngine } from "~/store/store.engine"
import { Icons } from "./icons"
import { Menu, type MenuItem } from "./menu"

// ────────────────────────────────────────────────────────────────────────────
// Quick-select: every command a project has — the supervised one first, then
// the named ones — toggled from a single popup. Two surfaces open it (the
// commands card in the detail view, and the project card in the fleet), and
// they must offer exactly the same list: a shortcut that differs from the thing
// it shortcuts is a second interface, not a shortcut.
//
// Mount it only while it is open. It loads the project's commands, and the
// board draws every card at once — a menu that fetched on mount would fetch the
// whole catalog's commands to render nothing.
// ────────────────────────────────────────────────────────────────────────────

export const QuickMenu = ({
  project,
  trigger,
  runner,
  onClose
}: {
  project: ProjectWithState
  trigger: HTMLElement
  /** The caller's runner, when it already has one. Sharing it keeps the local
   *  `starting` flag consistent between the menu and the table beneath it. */
  runner?: CommandRunner
  onClose: () => void
}) => {
  const own = useCommandRunner(project.id)
  const { statusOf, run, stop, kill } = runner ?? own
  const list = useProjectCommands(project.id)
  const { busy } = useLifecycleState(project)
  const startProject = useEngine((s) => s.start)
  const stopProject = useEngine((s) => s.stop)
  const killProject = useEngine((s) => s.kill)

  // The status IS the action — a running command's entry stops it — so there is
  // one item per command rather than a run/stop pair each.
  const projectUp = project.state === "running"
  const projectMoving = project.state === "starting" || project.state === "stopping"

  const items: ReadonlyArray<MenuItem> = [
    {
      key: "__project__",
      dot: projectUp ? "success" : projectMoving || busy ? "warning" : "danger",
      verb: projectUp ? "stop" : "start",
      label: project.name,
      // Only a transition earns words. "running" and "stopped" are already what
      // the dot says, and repeating them makes the settled rows the noisy ones.
      ...(project.state === "starting"
        ? { note: "starting" }
        : project.state === "stopping"
          ? { note: "stopping" }
          : {}),
      disabled: busy,
      onSelect: () => void (projectUp ? stopProject(project.id) : startProject(project.id)),
      action: {
        icon: <Icons.Skull size={12} filled={projectUp || busy} />,
        title: projectUp || busy ? "Force kill — no drain, no waiting" : "Nothing to kill",
        disabled: !projectUp && !busy,
        onClick: () => void killProject(project.id)
      }
    },
    ...list.map<MenuItem>((c) => {
      const status = statusOf(c.name)
      const up = status === "running"
      return {
        key: c.name,
        dot: up ? "success" : status === "starting" ? "warning" : "danger",
        verb: up ? "stop" : "start",
        label: c.name,
        ...(status === "starting" ? { note: "starting" } : {}),
        disabled: status === "starting",
        onSelect: () => (up ? stop(c.name) : void run(c.name, c.command)),
        action: {
          icon: <Icons.Skull size={12} filled={up} />,
          title: up ? "Kill this command" : "Nothing to kill",
          disabled: !up,
          onClick: () => kill(c.name)
        }
      }
    })
  ]

  return <Menu trigger={trigger} items={items} onClose={onClose} />
}
