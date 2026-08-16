import { Effect } from "effect"
import type { NotificationPrefs, ProjectId, Settings, SettingsPatch } from "@matisa/core"
import type { SettingsRepoShape } from "@matisa/store"
import { configChanged } from "../../shared/events.js"
import type { EventsHubShape } from "../server.events-hub.js"
import type { Handlers } from "../server.dispatcher.js"

// settings.get/set — the global preferences document.
//
// Stored as one row per top-level key rather than one row holding the whole
// document, so two clients writing different fields do not overwrite each
// other. Assembly and defaulting happen HERE, on the read: a key that has never
// been written is indistinguishable to a client from one written with the
// default, which is what lets the desktop ship a new preference without a
// migration or a backfill.
//
// Every write announces itself. The settings are shared state — the CLI reads
// the same operations instructions the desktop is editing — so a client that
// saved is not the only client whose copy just went stale.

const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  enabled: true,
  // A crash is the one event worth interrupting for by default. The others are
  // usually the consequence of something the user just did.
  crashed: true,
  stateChanged: false,
  healthChanged: false,
  osWhenUnfocused: true
}

const DEFAULTS: Settings = {
  operationsInstructions: "",
  notifications: DEFAULT_NOTIFICATIONS,
  hiddenProjects: [],
  hiddenGroups: []
}

/** Values arrive from the bag as `unknown` — a row written by an older version
 *  may be any shape at all. Anything that does not look right falls back to the
 *  default rather than propagating: a malformed preference must not be able to
 *  break the document that every other preference lives in. */
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback)

const strings = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback)

const notifications = (v: unknown): NotificationPrefs => {
  if (typeof v !== "object" || v === null) return DEFAULT_NOTIFICATIONS
  const raw = v as Record<string, unknown>
  return {
    enabled: bool(raw.enabled, DEFAULT_NOTIFICATIONS.enabled),
    crashed: bool(raw.crashed, DEFAULT_NOTIFICATIONS.crashed),
    stateChanged: bool(raw.stateChanged, DEFAULT_NOTIFICATIONS.stateChanged),
    healthChanged: bool(raw.healthChanged, DEFAULT_NOTIFICATIONS.healthChanged),
    osWhenUnfocused: bool(raw.osWhenUnfocused, DEFAULT_NOTIFICATIONS.osWhenUnfocused)
  }
}

export const settingsHandlers = (
  settings: SettingsRepoShape,
  events: EventsHubShape
): Pick<Handlers, "settings.get" | "settings.set"> => {
  const read = (): Effect.Effect<Settings> =>
    settings.all().pipe(
      Effect.map(
        (bag): Settings => ({
          operationsInstructions: str(bag.operationsInstructions, DEFAULTS.operationsInstructions),
          notifications: notifications(bag.notifications),
          hiddenProjects: strings(bag.hiddenProjects) as ReadonlyArray<ProjectId>,
          hiddenGroups: strings(bag.hiddenGroups)
        })
      ),
      Effect.orDie
    )

  return {
    "settings.get": () => read(),
    "settings.set": (params) => {
      const patch = params as SettingsPatch
      // Only the keys actually present are written. An absent key is "leave it
      // alone", not "reset it" — that distinction is the whole reason the wire
      // type is a patch rather than the document.
      const writes = Object.entries(patch)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => settings.set(key, value))
      return Effect.all(writes, { discard: true }).pipe(
        Effect.andThen(() => events.emit(configChanged("settings", "updated"))),
        Effect.andThen(read),
        Effect.orDie
      )
    }
  }
}
