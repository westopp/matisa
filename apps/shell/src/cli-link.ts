import { execFile } from "node:child_process"
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { app } from "electron"

// ────────────────────────────────────────────────────────────────────────────
// Putting `matisa` on PATH.
//
// The bundle already ships the CLI — resources/bin/matisa, a wrapper that walks
// its own symlink chain back to the app and runs the bundled cli.cjs under the
// app's Electron in Node mode. What it does NOT do is get there on its own:
// downloading the app leaves the terminal with no `matisa`, and the one command
// this machine's owner is told to run first, `matisa guide`, is not found.
//
// So the link is made from the app, and this module is the whole of it: whether
// one exists, and how to make one.
//
// /usr/local/bin is the target because it is on the default PATH of every macOS
// shell (it is in /etc/paths, ahead of anything a user's rc file may or may not
// add). ~/.local/bin needs no password but is on PATH only if the user put it
// there, and a button that reports success over a command that is still not
// found is worse than no button. Where the directory is not writable — the
// normal case on a Mac without Intel Homebrew — the link is made through one
// osascript admin prompt, which is the same thing `code` and `docker` do.
// ────────────────────────────────────────────────────────────────────────────

const LINK_DIR = "/usr/local/bin"
const LINK = join(LINK_DIR, "matisa")

/** State of the PATH link, as the window needs to render it. */
export interface CliLinkState {
  /** Whether linking is something this build can offer at all. False in dev,
   *  where the wrapper's route back to the bundle does not exist, and off
   *  darwin, where none of this applies. */
  readonly supported: boolean
  /** A `matisa` on PATH that resolves to THIS bundle's wrapper. A link left by
   *  a previous install pointing at a bundle that is gone — or at a different
   *  copy of the app — is not installed: it is the failure this reports. */
  readonly installed: boolean
  /** Where the link was found, when it was. */
  readonly path: string | null
  /** The command that does by hand exactly what "Install now" does, for the
   *  user who would rather run it themselves — and for the one whose admin
   *  prompt is refused by a managed machine. */
  readonly command: string
}

export type CliInstallResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string; readonly cancelled?: boolean }

/** The shipped wrapper inside this bundle. Only meaningful when packaged: the
 *  script resolves the app from its own location, and in dev there is no app
 *  around it to resolve. */
const wrapperPath = (): string | null =>
  app.isPackaged ? join(process.resourcesPath, "bin", "matisa") : null

const realpathOr = (p: string): string | null => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** Everywhere a `matisa` could already be, so an existing install is found
 *  wherever the user put it rather than only where this module would put one.
 *  The process PATH is included because a link in a directory this app cannot
 *  see is still a working command in the user's terminal — and the fixed
 *  candidates are included because a GUI app's PATH is the launchd default,
 *  which knows nothing of Homebrew. */
const searchDirs = (): ReadonlyArray<string> => {
  const fromPath = (process.env.PATH ?? "").split(delimiter).filter((d) => d !== "")
  return [
    ...new Set([
      LINK_DIR,
      "/opt/homebrew/bin",
      join(homedir(), ".local", "bin"),
      join(homedir(), "bin"),
      ...fromPath
    ])
  ]
}

export const cliLinkState = (): CliLinkState => {
  const wrapper = wrapperPath()
  const command = `sudo ln -sfn "${wrapper ?? "/Applications/Matisa.app/Contents/Resources/bin/matisa"}" ${LINK}`
  if (process.platform !== "darwin" || wrapper === null) {
    return { supported: false, installed: false, path: null, command }
  }

  // Compared through realpath on BOTH sides: the link's target and the bundle
  // are the same file or they are not, whatever chain of links or /var →
  // /private/var indirection sits between the two paths.
  const target = realpathOr(wrapper)
  for (const dir of searchDirs()) {
    const candidate = join(dir, "matisa")
    if (target !== null && realpathOr(candidate) === target) {
      return { supported: true, installed: true, path: candidate, command }
    }
  }
  return { supported: true, installed: false, path: null, command }
}

/** `ln -sfn wrapper /usr/local/bin/matisa`, as the user, through an admin
 *  prompt if that is what the directory's permissions require. */
const linkWithAdmin = (wrapper: string): Promise<CliInstallResult> =>
  new Promise((resolve) => {
    // The wrapper path is this bundle's own — never anything a renderer sent —
    // but it lands inside a shell string inside an AppleScript string, so it is
    // checked rather than trusted. A bundle installed somewhere with a quote in
    // the name gets the copyable command instead of a mangled one run as root.
    if (/['"\\$`]/.test(wrapper)) {
      resolve({ ok: false, reason: "The app is in a folder whose name cannot be used here — run the command by hand." })
      return
    }
    const sh = `mkdir -p '${LINK_DIR}' && ln -sfn '${wrapper}' '${LINK}'`
    execFile(
      "/usr/bin/osascript",
      ["-e", `do shell script ${JSON.stringify(sh)} with administrator privileges`],
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, path: LINK })
          return
        }
        // Dismissing the password dialog is not a failure to report as one —
        // the user just said no, and the window should go quiet rather than
        // put an error in front of them.
        const message = `${stderr}${error.message}`
        if (message.includes("-128") || message.includes("User canceled")) {
          resolve({ ok: false, reason: "Cancelled.", cancelled: true })
          return
        }
        resolve({ ok: false, reason: message.trim().split("\n")[0] ?? "The link could not be created." })
      }
    )
  })

export const installCliLink = async (): Promise<CliInstallResult> => {
  const wrapper = wrapperPath()
  if (process.platform !== "darwin" || wrapper === null) {
    return { ok: false, reason: "Only the packaged macOS app can install the command." }
  }

  // Without a prompt first. On a Mac with Intel Homebrew /usr/local/bin is
  // already the user's to write, and asking for a password to do something that
  // needs none is how a prompt stops meaning anything.
  try {
    mkdirSync(LINK_DIR, { recursive: true })
    rmSync(LINK, { force: true })
    symlinkSync(wrapper, LINK)
    return { ok: true, path: LINK }
  } catch {
    return linkWithAdmin(wrapper)
  }
}
