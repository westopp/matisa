import { useEffect } from "react"
import { create } from "zustand"
import { rpc } from "~/rpc/rpc.client"

// ────────────────────────────────────────────────────────────────────────────
// Project artwork. The catalog stores a PATH; a browser tab cannot open a
// file:// URL, so the engine inlines the bytes (fs.readIcon) and this caches the
// resulting data URI by path.
//
// A failed read is cached as `null` — an icon that was deleted or renamed must
// not retry on every render of the sidebar. Keyed by path, so pointing a project
// at a different file is picked up; rewriting the SAME path needs a reload.
// ────────────────────────────────────────────────────────────────────────────

interface IconState {
  readonly icons: Readonly<Record<string, string | null>>
  readonly load: (path: string) => void
}

const inflight = new Set<string>()

export const useIcons = create<IconState>()((set, get) => ({
  icons: {},

  load: (path) => {
    if (path === "" || inflight.has(path) || get().icons[path] !== undefined) return
    inflight.add(path)
    void rpc
      .call("fs.readIcon", { path })
      .then((result) => set((s) => ({ icons: { ...s.icons, [path]: result.dataUri } })))
      // Silent: a broken icon path falls back to the kind glyph. It is not worth
      // a toast on every render of a list.
      .catch(() => set((s) => ({ icons: { ...s.icons, [path]: null } })))
      .finally(() => inflight.delete(path))
  }
}))

/** The data URI for `path`, or null while loading / when it cannot be read. */
export const useIcon = (path: string | undefined): string | null => {
  const load = useIcons((s) => s.load)
  const uri = useIcons((s) => (path === undefined ? null : (s.icons[path] ?? null)))

  useEffect(() => {
    if (path !== undefined) load(path)
  }, [path, load])

  return uri
}
