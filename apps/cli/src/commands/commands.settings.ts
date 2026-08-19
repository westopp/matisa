import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import { ProjectId, type NotificationPrefs, type SettingsPatch } from "@matisa/core"
import { call } from "../transport/transport.index.js"
import { Renderer } from "../render/render.index.js"
import { applyGlobals } from "../cli.globals.js"

// settings get | set — the global preferences document, from the terminal.
//
// Generic rather than a command per preference. The document is a handful of
// keys today and will not stay that way, and a CLI that needs a new verb every
// time the desktop grows a checkbox is a CLI that falls behind the desktop —
// which is the exact asymmetry the two-clients-are-peers rule exists to
// prevent. `settings get --json` hands an agent the whole thing in one call.
//
// Nested keys are addressed with a dot: `notifications.crashed`. That is the
// only structure in the document, so a full path syntax would be machinery for
// one level of nesting.
//
// The operations instructions have their OWN command as well. That is not a
// duplicate: the guide points agents at it by name, and the rules a person
// wrote to be read before acting should not be one key among many in a
// preferences bag.

const NOTIFICATION_KEYS = [
  "enabled",
  "crashed",
  "stateChanged",
  "healthChanged",
  "osWhenUnfocused"
] as const

type NotificationKey = (typeof NOTIFICATION_KEYS)[number]

const isNotificationKey = (k: string): k is NotificationKey =>
  (NOTIFICATION_KEYS as ReadonlyArray<string>).includes(k)

/** Accept what a person would actually type. `true/false` is the documented
 *  form; on/off and yes/no are accepted because refusing them teaches nothing
 *  and costs the user a second attempt. */
const asBoolean = (raw: string): boolean | null => {
  const v = raw.trim().toLowerCase()
  if (v === "true" || v === "on" || v === "yes" || v === "1") return true
  if (v === "false" || v === "off" || v === "no" || v === "0") return false
  return null
}

/** A list for the hidden keys: comma-separated, or empty to clear. */
const asList = (raw: string): ReadonlyArray<string> =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")

const get = Command.make("get", {}, () =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer
    const s = yield* call("settings.get", undefined)
    const n = s.notifications
    yield* render.raw(
      s,
      [
        `operationsInstructions  ${s.operationsInstructions === "" ? "(unset)" : `${s.operationsInstructions.split("\n").length} line(s)`}`,
        `notifications.enabled          ${n.enabled}`,
        `notifications.crashed          ${n.crashed}`,
        `notifications.stateChanged     ${n.stateChanged}`,
        `notifications.healthChanged    ${n.healthChanged}`,
        `notifications.osWhenUnfocused  ${n.osWhenUnfocused}`,
        `hiddenProjects  ${s.hiddenProjects.length === 0 ? "(none)" : s.hiddenProjects.join(", ")}`,
        `hiddenGroups    ${s.hiddenGroups.length === 0 ? "(none)" : s.hiddenGroups.join(", ")}`
      ].join("\n")
    )
  })
).pipe(Command.withDescription("Print the whole settings document"))

const keyArg = Args.text({ name: "key" })
const valueArg = Args.text({ name: "value" })

const set = Command.make("set", { key: keyArg, value: valueArg }, ({ key, value }) =>
  Effect.gen(function* () {
    yield* applyGlobals
    const render = yield* Renderer

    // Built as a patch, so a write to one key cannot flatten the rest — the
    // same contract the desktop writes under.
    const patch = yield* buildPatch(key, value)
    const saved = yield* call("settings.set", patch)
    yield* render.raw(saved, `${key} = ${value}`)
  })
).pipe(
  Command.withDescription(
    "Set one setting: operationsInstructions, notifications.<flag>, hiddenProjects, hiddenGroups"
  )
)

/** Turn `key value` into a patch, refusing anything that is not a real key
 *  rather than silently writing a row nothing will ever read.
 *
 *  A bad key is a defect, not a failure to model: the caller mistyped, there is
 *  no recovery, and the message naming the valid keys is the whole remedy. */
const buildPatch = (key: string, value: string) =>
  Effect.gen(function* () {
    if (key === "operationsInstructions") return { operationsInstructions: value } satisfies SettingsPatch

    if (key.startsWith("notifications.")) {
      const flag = key.slice("notifications.".length)
      if (!isNotificationKey(flag)) {
        return yield* Effect.die(
          new Error(`unknown notification flag "${flag}" — one of: ${NOTIFICATION_KEYS.join(", ")}`)
        )
      }
      const on = asBoolean(value)
      if (on === null) return yield* Effect.die(new Error(`${key} takes true or false, got "${value}"`))

      // Read-modify-write: the wire type for notifications is the whole prefs
      // object, so setting one flag has to carry the other four. Racy in
      // principle; the loser of a race is a preference, and the alternative is
      // a per-flag method for something a person toggles by hand.
      const current = yield* call("settings.get", undefined)
      const next: NotificationPrefs = { ...current.notifications, [flag]: on }
      return { notifications: next } satisfies SettingsPatch
    }

    if (key === "hiddenProjects") {
      return { hiddenProjects: asList(value).map((id) => ProjectId.make(id)) } satisfies SettingsPatch
    }
    if (key === "hiddenGroups") return { hiddenGroups: asList(value) } satisfies SettingsPatch

    return yield* Effect.die(
      new Error(
        `unknown setting "${key}" — one of: operationsInstructions, notifications.<flag>, hiddenProjects, hiddenGroups`
      )
    )
  })

export const settings = Command.make("settings").pipe(
  Command.withSubcommands([get, set]),
  Command.withDescription("Read and write the global settings document")
)
