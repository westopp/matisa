import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import { Effect } from "effect"
import {
  ValidationError,
  type ChooseDirParams,
  type ChooseFileParams,
  type ListDirParams,
  type ReadIconParams
} from "@matisa/core"
import type { Handlers } from "../server.dispatcher.js"

// ────────────────────────────────────────────────────────────────────────────
// fs.* — the client is a web UI in a sandbox and can never see a real path, so
// the engine (a local process with actual filesystem access) does that work:
//
//   fs.chooseDir  opens the genuine macOS folder panel via osascript and hands
//                 back the absolute POSIX path the user picked.
//   fs.chooseFile the same panel for a single file (project icons).
//   fs.listDir    read-only existence/stat check, used to verify typed paths.
//   fs.readIcon   inlines an image as a data URI — a browser cannot open the
//                 file:// URL a stored icon path points at.
//
// Read-only by design: nothing here creates, moves or deletes.
// ────────────────────────────────────────────────────────────────────────────

/** AppleScript's "user cancelled" (-128). A dismissed panel is a normal
 *  outcome, not a failure — it must not surface as an error toast. */
const USER_CANCELLED = "-128"

const chooseDirectory = (defaultPath?: string): Promise<string | undefined> => {
  // `choose folder` belongs to whichever app hosts it; hosting it in System
  // Events and activating first is what pulls the panel to the front, since
  // the engine is a background process with no app bundle of its own.
  const location =
    defaultPath === undefined || defaultPath.trim() === ""
      ? ""
      : ` default location (POSIX file ${JSON.stringify(defaultPath)})`

  const script = `tell application "System Events"
    activate
    set chosen to choose folder with prompt "Choose a project folder"${location}
  end tell
  return POSIX path of chosen`

  return new Promise((resolvePromise, rejectPromise) => {
    execFile("osascript", ["-e", script], (error, stdout, stderr) => {
      if (error !== null) {
        if (stderr.includes(USER_CANCELLED)) {
          resolvePromise(undefined)
          return
        }
        rejectPromise(new Error(stderr.trim() === "" ? error.message : stderr.trim()))
        return
      }
      // `POSIX path of` yields a trailing slash for directories; the engine
      // stores roots without one, so paths compare equal across the app.
      const path = stdout.trim().replace(/(?!^)\/$/, "")
      resolvePromise(path === "" ? undefined : path)
    })
  })
}

const chooseSingleFile = (
  defaultPath: string | undefined,
  extensions: ReadonlyArray<string>
): Promise<string | undefined> => {
  const location =
    defaultPath === undefined || defaultPath.trim() === ""
      ? ""
      : ` default location (POSIX file ${JSON.stringify(defaultPath)})`
  const ofType =
    extensions.length === 0 ? "" : ` of type {${extensions.map((e) => JSON.stringify(e)).join(", ")}}`

  const script = `tell application "System Events"
    activate
    set chosen to choose file with prompt "Choose an icon"${ofType}${location}
  end tell
  return POSIX path of chosen`

  return new Promise((resolvePromise, rejectPromise) => {
    execFile("osascript", ["-e", script], (error, stdout, stderr) => {
      if (error !== null) {
        if (stderr.includes(USER_CANCELLED)) {
          resolvePromise(undefined)
          return
        }
        rejectPromise(new Error(stderr.trim() === "" ? error.message : stderr.trim()))
        return
      }
      const path = stdout.trim()
      resolvePromise(path === "" ? undefined : path)
    })
  })
}

/** Icons are inlined into the client, so the cap is about what a data URI can
 *  sanely carry over the socket, not about what the disk holds. */
const MAX_ICON_BYTES = 2 * 1024 * 1024

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".icns": "image/x-icns"
}

export const fsHandlers = (): Pick<
  Handlers,
  "fs.listDir" | "fs.chooseDir" | "fs.chooseFile" | "fs.readIcon"
> => ({
  "fs.chooseDir": (params) => {
    if (platform() !== "darwin") {
      return Effect.fail(
        new ValidationError({
          field: "root",
          message: "Folder picker needs macOS — type the path instead."
        })
      )
    }

    return Effect.tryPromise({
      try: () => chooseDirectory((params as ChooseDirParams).defaultPath),
      catch: (cause) =>
        new ValidationError({
          field: "root",
          message: cause instanceof Error ? cause.message : "Could not open the folder picker"
        })
    }).pipe(Effect.map((path) => (path === undefined ? {} : { path })))
  },

  "fs.chooseFile": (params) => {
    if (platform() !== "darwin") {
      return Effect.fail(
        new ValidationError({
          field: "pathToIcon",
          message: "File picker needs macOS — type the path instead."
        })
      )
    }

    const p = params as ChooseFileParams
    return Effect.tryPromise({
      try: () => chooseSingleFile(p.defaultPath, p.extensions),
      catch: (cause) =>
        new ValidationError({
          field: "pathToIcon",
          message: cause instanceof Error ? cause.message : "Could not open the file picker"
        })
    }).pipe(Effect.map((path) => (path === undefined ? {} : { path })))
  },

  "fs.readIcon": (params) => {
    const path = resolve((params as ReadIconParams).path)
    const mime = MIME_BY_EXT[extname(path).toLowerCase()]
    if (mime === undefined) {
      return Effect.fail(
        new ValidationError({
          field: "pathToIcon",
          message: `${extname(path) || "That file"} is not an image format the UI can show`
        })
      )
    }

    return Effect.tryPromise({
      try: async () => {
        const stat = await fs.stat(path)
        if (!stat.isFile()) throw new Error("Not a file")
        if (stat.size > MAX_ICON_BYTES) {
          throw new Error(`Icon is ${Math.round(stat.size / 1024)}KB — the limit is 2MB`)
        }
        const bytes = await fs.readFile(path)
        return { dataUri: `data:${mime};base64,${bytes.toString("base64")}` }
      },
      catch: (cause) =>
        new ValidationError({
          field: "pathToIcon",
          message: cause instanceof Error ? cause.message : `Could not read ${path}`
        })
    })
  },

  "fs.listDir": (params) => {
    const requested = (params as ListDirParams).path
    const target = requested === undefined || requested.trim() === "" ? homedir() : resolve(requested)

    return Effect.tryPromise({
      try: async () => {
        const dirents = await fs.readdir(target, { withFileTypes: true })
        const entries = dirents
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => ({ name: d.name, path: join(target, d.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
        const parent = dirname(target)
        return { path: target, parent: parent === target ? undefined : parent, entries }
      },
      catch: (cause) =>
        new ValidationError({
          field: "path",
          message: cause instanceof Error ? cause.message : `Could not read ${target}`
        })
    })
  }
})
