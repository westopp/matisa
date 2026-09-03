import { execFile } from "node:child_process"
import { constants, promises as fs } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import { Effect } from "effect"
import {
  ValidationError,
  type ChooseDirParams,
  type ChooseFileParams,
  type DeniedRoot,
  type ListDirParams,
  type Project,
  type ReadIconParams,
  type RevealParams
} from "@matisa/core"
import type { CatalogShape } from "../../modules/catalog/catalog.services.js"
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
//   fs.access     which catalog roots the OS refuses this process. macOS only,
//                 and the one call here that is about the engine rather than
//                 about a path the user typed.
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

/** Hand a path to the OS file manager, selected in its parent folder. `open -R`
 *  takes the path as an argument, never as shell text, so a folder name with a
 *  space, a quote or a `;` in it is data — there is no shell to confuse. */
const revealInFileManager = (path: string): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile("open", ["-R", path], (error, _stdout, stderr) => {
      if (error !== null) {
        rejectPromise(new Error(stderr.trim() === "" ? error.message : stderr.trim()))
        return
      }
      resolvePromise()
    })
  })


// ── TCC ─────────────────────────────────────────────────────────────────────
// The probe is `access(R_OK)`, and it has to be. `stat(2)` SUCCEEDS on a
// directory this process may not read — verified against a genuinely denied
// engine, where ~/Desktop stats fine and every one of readdir, opendir and
// access answers EPERM. A stat-based check reports nothing wrong on precisely
// the machine this exists for, which is worse than having no check: the window
// would state that access is fine while every project under that root fails.
//
// A folder macOS protects and this process has no grant for answers EPERM —
// not ENOENT, not EACCES. The distinction is the whole value of this check:
//
//   ENOENT  the root was moved or deleted. The user's problem, and one the
//           catalog already shows as a broken path.
//   EACCES  ordinary unix permissions. A real failure, but chmod fixes it and
//           sending someone to Privacy & Security would be a wrong answer.
//   EPERM   the kernel refused a process that is otherwise entitled to the
//           bytes. On macOS, on a path under a protected folder, that is TCC.
//
// So only EPERM is reported. Over-reporting here costs more than missing a
// case: the notice this feeds tells the user to grant Full Disk Access, and it
// must never say that about a directory they simply deleted.
const DENIED = "EPERM"

const errno = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : undefined

/** Roots are probed once each, not once per project: a monorepo puts a dozen
 *  catalog entries under one directory, and the answer is a property of the
 *  directory. Every project under a refused root is still listed — the window
 *  counts projects, because that is what the user recognises. */
const deniedRoots = async (projects: ReadonlyArray<Project>): Promise<ReadonlyArray<DeniedRoot>> => {
  const refused = new Set<string>()

  for (const root of new Set(projects.map((p) => p.root))) {
    const denied = await fs.access(root, constants.R_OK).then(
      () => false,
      (cause: unknown) => errno(cause) === DENIED
    )
    if (denied) refused.add(root)
  }

  return projects
    .filter((p) => refused.has(p.root))
    .map((p) => ({ projectId: p.id, name: p.name, root: p.root }))
}

export const fsHandlers = (catalog: CatalogShape): Pick<
  Handlers,
  "fs.listDir" | "fs.chooseDir" | "fs.chooseFile" | "fs.readIcon" | "fs.reveal" | "fs.access"
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

  "fs.reveal": (params) => {
    if (platform() !== "darwin") {
      return Effect.fail(
        new ValidationError({ field: "path", message: "Reveal needs macOS" })
      )
    }

    const path = resolve((params as RevealParams).path)
    return Effect.tryPromise({
      try: async () => {
        // Stat first so a stale root fails with "no such folder" rather than
        // whatever the file manager decides to do with a path that is not there.
        await fs.stat(path)
        await revealInFileManager(path)
      },
      catch: (cause) =>
        new ValidationError({
          field: "path",
          message: cause instanceof Error ? cause.message : `Could not reveal ${path}`
        })
    })
  },

  // Never fails. A denial check that itself errors would take the window's only
  // explanation of a denial with it, so an unreadable catalog reports an empty
  // list — "nothing known to be refused" — and the projects fail on their own
  // terms, which is the behaviour without this call at all.
  "fs.access": () => {
    if (platform() !== "darwin") {
      return Effect.succeed({ supported: false, denied: [], checkedAt: Date.now() })
    }

    return catalog.list().pipe(
      Effect.flatMap((projects) =>
        Effect.promise(() => deniedRoots(projects))
      ),
      Effect.map((denied) => ({ supported: true, denied, checkedAt: Date.now() })),
      Effect.catchAllCause(() =>
        Effect.succeed({ supported: true, denied: [] as ReadonlyArray<DeniedRoot>, checkedAt: Date.now() })
      )
    )
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
