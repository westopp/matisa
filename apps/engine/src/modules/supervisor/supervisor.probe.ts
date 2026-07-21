import { Duration, Effect, Schedule } from "effect"
import { execFile } from "node:child_process"
import { connect } from "node:net"

// ────────────────────────────────────────────────────────────────────────────
// Port observation, two distinct questions:
//
// `foreignListener` — asked ONCE before spawn: is the declared port already
// bound by a process we don't manage? If so the start fails loud with a typed
// PortBusy naming pid + process (the user always knows who owns it).
//
// `awaitPortBound` — the readiness probe: during `starting` only, poll a TCP
// connect until the port accepts or the window closes. Once ready the engine
// stops watching entirely (probe-until-ready, then hands off). Steady-state
// liveness stays event-derived — this never polls a running service.
// ────────────────────────────────────────────────────────────────────────────

export interface ForeignListener {
  readonly pid?: number
  readonly processName?: string
}

/** lsof lookup of who holds a TCP listen on `port`; undefined = port free. */
export const foreignListener = (
  port: number
): Effect.Effect<ForeignListener | undefined> =>
  Effect.async<ForeignListener | undefined>((resume) => {
    execFile(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
      { timeout: 2_000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resume(Effect.succeed(undefined))
        // -F output: lines like "p1234" (pid) and "cnode" (command)
        let pid: number | undefined
        let processName: string | undefined
        for (const line of stdout.split("\n")) {
          if (line.startsWith("p") && pid === undefined) pid = Number(line.slice(1))
          if (line.startsWith("c") && processName === undefined) processName = line.slice(1)
        }
        resume(Effect.succeed({ pid, processName }))
      }
    )
  })

const tryConnect = (port: number): Effect.Effect<boolean> =>
  Effect.async<boolean>((resume) => {
    const sock = connect({ port, host: "127.0.0.1" })
    const done = (ok: boolean) => {
      sock.destroy()
      resume(Effect.succeed(ok))
    }
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
    sock.setTimeout(1_000, () => done(false))
  })

/** Poll until the port accepts a TCP connection; false = window elapsed. */
export const awaitPortBound = (port: number, timeoutMs: number): Effect.Effect<boolean> =>
  tryConnect(port).pipe(
    Effect.flatMap((ok) => (ok ? Effect.succeed(true) : Effect.fail("unbound" as const))),
    Effect.retry(
      Schedule.spaced(Duration.millis(250)).pipe(Schedule.upTo(Duration.millis(timeoutMs)))
    ),
    Effect.catchAll(() => Effect.succeed(false))
  )
