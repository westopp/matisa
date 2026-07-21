import { Effect, type Scope } from "effect"
import { spawn } from "node:child_process"

// ────────────────────────────────────────────────────────────────────────────
// Container event watcher — the state-is-truth upgrade over the old app's
// `docker ps` polling. `docker events` is the daemon's push stream; we filter
// to one container and surface start/die (with the real exit code) to the
// runner, which feeds the same FSM as process projects. Scope-managed: the
// watcher child dies with the run's scope.
// ────────────────────────────────────────────────────────────────────────────

export interface ContainerEvent {
  readonly status: "start" | "die" | "stop"
  readonly exitCode: number | null
}

export const watchContainer = (
  containerName: string,
  onEvent: (e: ContainerEvent) => void
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn(
        "docker",
        [
          "events",
          "--filter", `container=${containerName}`,
          "--filter", "event=start",
          "--filter", "event=die",
          "--filter", "event=stop",
          "--format", "{{json .}}"
        ],
        { stdio: ["ignore", "pipe", "ignore"] }
      )
      let buf = ""
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8")
        let i
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          try {
            const ev = JSON.parse(line) as {
              status?: string
              Actor?: { Attributes?: { exitCode?: string } }
            }
            if (ev.status === "start" || ev.status === "die" || ev.status === "stop") {
              const raw = ev.Actor?.Attributes?.exitCode
              onEvent({
                status: ev.status,
                exitCode: raw === undefined ? null : Number(raw)
              })
            }
          } catch {
            // non-JSON noise from the CLI — ignore
          }
        }
      })
      return child
    }),
    (child) =>
      Effect.sync(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // already gone
        }
      })
  ).pipe(Effect.asVoid)
