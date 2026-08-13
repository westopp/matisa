import { ProjectId } from "@matisa/core"

// ────────────────────────────────────────────────────────────────────────────
// Systems, addressed the way projects are.
//
// The engine and the Docker daemon are not projects, but everything that makes
// a project inspectable — the failure list, the activity log, the drawer's
// scope switch, the selection in the sidebar — is keyed on a ProjectId. That is
// why a system used to be a dead end: no id, so no route to open, no rows to
// filter, and a status glyph with nothing behind it.
//
// So they get ids. `sys:` is a prefix no catalog project can hold (project ids
// are minted from slugs), which keeps the two namespaces apart while letting a
// system flow through machinery that only ever wanted an id.
// ────────────────────────────────────────────────────────────────────────────

export const SYSTEM_IDS = {
  engine: ProjectId.make("sys:engine"),
  docker: ProjectId.make("sys:docker"),
  discovery: ProjectId.make("sys:discovery")
} as const

export type SystemKey = keyof typeof SYSTEM_IDS

const NAMES: Record<string, string> = {
  [SYSTEM_IDS.engine]: "Engine",
  [SYSTEM_IDS.docker]: "Docker",
  [SYSTEM_IDS.discovery]: "Discovery"
}

export const isSystemId = (id: string): boolean => id in NAMES

/** The display name, or undefined when the id is a project's. Callers that
 *  already resolve project names fall through to their own lookup. */
export const systemName = (id: string): string | undefined => NAMES[id]

export const systemKeyOf = (id: string): SystemKey | null =>
  id === SYSTEM_IDS.engine
    ? "engine"
    : id === SYSTEM_IDS.docker
      ? "docker"
      : id === SYSTEM_IDS.discovery
        ? "discovery"
        : null
