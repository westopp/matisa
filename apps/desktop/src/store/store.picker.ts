import { rpc } from "~/rpc/rpc.client"

// Path helpers for form fields. Both delegate to the engine, because a browser
// tab can never see a real filesystem path — `webkitdirectory` deliberately
// exposes only a relative name, and the engine needs an absolute root to spawn
// into. The engine is a local process, so it can do both jobs natively.

/** Opens the real macOS folder panel. Resolves to null when the user cancels —
 *  a dismissed panel is a normal outcome, so callers just leave the field be. */
export const chooseDirectory = async (defaultPath?: string): Promise<string | null> => {
  const result = await rpc.call("fs.chooseDir", { defaultPath })
  return result.path ?? null
}

const IMAGE_EXTENSIONS = ["png", "svg", "jpg", "jpeg", "webp", "gif", "icns", "ico"]

/** Opens the real macOS file panel, filtered to image types. Null on cancel. */
export const chooseImageFile = async (defaultPath?: string): Promise<string | null> => {
  const result = await rpc.call("fs.chooseFile", { defaultPath, extensions: IMAGE_EXTENSIONS })
  return result.path ?? null
}

/** Confirms `path` exists and is a readable directory. Gates hand-typed paths
 *  so a bad root fails here, in the field, instead of at spawn time. */
export const checkDirectoryExists = async (path: string): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    await rpc.call("fs.listDir", { path })
    return { ok: true }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : "Could not read that folder" }
  }
}

/** Confirms `path` is an image the UI can actually render — the read is the
 *  same one the sidebar will make, so a path that passes here will show. */
export const checkImageReadable = async (path: string): Promise<{ ok: true } | { ok: false; message: string }> => {
  try {
    await rpc.call("fs.readIcon", { path })
    return { ok: true }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : "Could not read that image" }
  }
}
