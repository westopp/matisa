import { Effect } from "effect"
import { execFile } from "node:child_process"
import { DockerCliError } from "./docker.errors.js"

// Thin async-shell helper for docker/compose CLI calls. Captures a stderr tail
// so failures surface WHY (the old app's summarize-stderr behavior). Never
// throws — every failure is a typed DockerCliError.

export interface ShellResult {
  readonly stdout: string
  readonly stderr: string
}

export const sh = (
  bin: string,
  args: ReadonlyArray<string>,
  opts?: { readonly cwd?: string; readonly timeoutMs?: number }
): Effect.Effect<ShellResult, DockerCliError> =>
  Effect.async<ShellResult, DockerCliError>((resume) => {
    const child = execFile(
      bin,
      [...args],
      { cwd: opts?.cwd, timeout: opts?.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || err.message || "").trim().split("\n").slice(-5).join("\n")
          resume(
            Effect.fail(
              new DockerCliError({ command: `${bin} ${args.join(" ")}`, stderrTail: tail })
            )
          )
        } else {
          resume(Effect.succeed({ stdout, stderr }))
        }
      }
    )
    return Effect.sync(() => {
      child.kill("SIGKILL")
    })
  })
