import { Data } from "effect"

/** A docker/compose CLI invocation failed; carries the stderr tail (the WHY). */
export class DockerCliError extends Data.TaggedError("DockerCliError")<{
  readonly command: string
  readonly stderrTail: string
}> {}

/** Docker Desktop did not become ready within the start window. */
export class DaemonStartTimeout extends Data.TaggedError("DaemonStartTimeout")<{
  readonly waitedMs: number
}> {}
