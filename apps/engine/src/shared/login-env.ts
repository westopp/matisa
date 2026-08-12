import { Effect } from "effect"
import { execFile } from "node:child_process"

// ────────────────────────────────────────────────────────────────────────────
// Login-shell PATH adoption — env layer 0, resolved once at boot.
//
// Every spawn the engine performs inherits `process.env`, so whatever PATH the
// engine was started with is the PATH every supervised project, every named
// command and every `docker` invocation gets. Started from a terminal that is
// your interactive shell's PATH and everything works. Started by the Electron
// shell — which launchd hands a bare `/usr/bin:/bin:/usr/sbin:/sbin` — and
// nvm, fnm, volta, mise, asdf, homebrew, pnpm, bun and cargo are all simply
// absent, so a perfectly good project dies on `vite: command not found` with
// nothing in the log to explain why it worked yesterday in dev.
//
// So: ask the user's own shell what PATH it would give them, once, and adopt
// it. `-l` runs the profile (where `brew shellenv` lives), `-i` runs the rc
// file (where the version managers live) — both are needed, and only the
// interactive pass finds nvm. This is deliberately NOT a per-spawn shell
// wrapper: re-running someone's whole rc file on every start would cost
// hundreds of milliseconds each time and put a shell between us and the
// child's process group, which is what makes signalling and reaping honest.
//
// Everything here degrades to a no-op: a shell that is missing, slow, hangs on
// a bad rc file, or prints nothing leaves the inherited PATH untouched.
// ────────────────────────────────────────────────────────────────────────────

/** Bound on the whole probe. A login+interactive shell is ~100–500ms; anything
 *  past this is an rc file waiting on something (a prompt, a network call) and
 *  boot must not wait with it. */
const PROBE_TIMEOUT_MS = 3_000

/** Wrapping the value means rc-file chatter on stdout — greetings, `nvm use`
 *  notices, fastfetch — cannot be mistaken for the PATH. */
const MARK = "__MATISA_PATH__"

const probeLoginPath = (): Effect.Effect<string | null> =>
  Effect.async<string | null>((resume) => {
    const shell = process.env["SHELL"] ?? "/bin/zsh"
    const child = execFile(
      shell,
      ["-ilc", `printf '\\n${MARK}%s\\n' "$PATH"`],
      { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      (_error, stdout) => {
        // `_error` is ignored on purpose: an interactive shell frequently exits
        // non-zero or complains about job control while still printing a
        // perfectly good PATH. The marker is the only success signal that
        // matters.
        const line = stdout.split("\n").find((l) => l.startsWith(MARK))
        const value = line?.slice(MARK.length).trim()
        resume(Effect.succeed(value !== undefined && value.length > 0 ? value : null))
      }
    )
    return Effect.sync(() => child.kill())
  })

/** Login PATH first, then any inherited entry it does not already contain.
 *  Additive rather than replacing: the shell's answer is the one we want to
 *  lead with, but a path the runtime injected and the shell knows nothing about
 *  (Electron's own bundled binaries, a CI shim) is not ours to drop. */
const merge = (loginPath: string, inherited: string | undefined): string => {
  const login = loginPath.split(":").filter((p) => p.length > 0)
  const seen = new Set(login)
  const extra = (inherited ?? "")
    .split(":")
    .filter((p) => p.length > 0 && !seen.has(p))
  return [...login, ...extra].join(":")
}

/** Resolve the user's login PATH and install it on `process.env`, so every
 *  later spawn inherits it. Mutating the process environment is the point: the
 *  fix has to reach the `docker` CLI and the PTY shells too, and neither goes
 *  through the env-context layers.
 *
 *  Runs BEFORE the socket opens — see main.ts — so no client can ask for a
 *  spawn against the un-fixed PATH. Set MATISA_NO_LOGIN_SHELL=1 to skip. */
export const adoptLoginPath: Effect.Effect<void> = Effect.gen(function* () {
  if (process.env["MATISA_NO_LOGIN_SHELL"] === "1") {
    yield* Effect.logDebug("login PATH probe skipped (MATISA_NO_LOGIN_SHELL=1)")
    return
  }

  const loginPath = yield* probeLoginPath()
  if (loginPath === null) {
    yield* Effect.logWarning(
      `could not read PATH from ${process.env["SHELL"] ?? "/bin/zsh"} — spawns inherit the engine's PATH, ` +
        "which may not include version-managed toolchains"
    )
    return
  }

  const inherited = process.env["PATH"]
  const merged = merge(loginPath, inherited)
  if (merged === inherited) {
    yield* Effect.logDebug("login PATH matches the inherited PATH — nothing to adopt")
    return
  }

  process.env["PATH"] = merged
  const gained = merged.split(":").length - (inherited ?? "").split(":").filter((p) => p.length > 0).length
  yield* Effect.logInfo(`adopted login-shell PATH (${gained} entries the engine did not have)`)
})
