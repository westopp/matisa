import { Context, Effect, Layer } from "effect"
import { Store } from "../store.client.js"
import { StoreQueryError } from "../store.errors.js"

// ────────────────────────────────────────────────────────────────────────────
// SettingsRepo — the key→JSON bag from 0001_init, finally given a reader.
//
// Everything global lives here: the operations instructions an agent reads
// before it touches anything, which events raise a notification, what the user
// has hidden. All of it is one row per key rather than a column per preference,
// because a preference is not a schema change — adding one should not cost a
// migration, and the engine has no opinion about most of what the desktop keeps
// in here.
//
// Values are stored as JSON, so a caller gets `unknown` back and is the one that
// knows the shape. `getAs` exists so that decision is made once, at the call
// site, with a default for the row that is not there yet — which is every row
// until someone saves something.
// ────────────────────────────────────────────────────────────────────────────

interface SettingRowRaw {
  readonly key: string
  readonly value_json: string
}

export interface SettingsRepoShape {
  readonly get: (key: string) => Effect.Effect<unknown, StoreQueryError>
  /** The whole bag, for the one caller that wants to hand it over verbatim. */
  readonly all: () => Effect.Effect<Record<string, unknown>, StoreQueryError>
  readonly set: (key: string, value: unknown) => Effect.Effect<void, StoreQueryError>
  readonly remove: (key: string) => Effect.Effect<void, StoreQueryError>
}

export class SettingsRepo extends Context.Tag("SettingsRepo")<SettingsRepo, SettingsRepoShape>() {}

export const SettingsRepoLive = Layer.effect(
  SettingsRepo,
  Effect.gen(function* () {
    const { sqlite } = yield* Store

    const q = <A>(fn: () => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({ try: fn, catch: (cause) => new StoreQueryError({ cause }) })

    // A row that will not parse is treated as absent rather than fatal: a
    // half-written preference must not be able to stop the engine from booting.
    const parse = (raw: string): unknown => {
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    }

    const get: SettingsRepoShape["get"] = (key) =>
      q(() => {
        const row = sqlite.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
          | { readonly value_json: string }
          | undefined
        return row === undefined ? undefined : parse(row.value_json)
      })

    const all: SettingsRepoShape["all"] = () =>
      q(() => {
        const rows = sqlite
          .prepare("SELECT key, value_json FROM settings")
          .all() as ReadonlyArray<SettingRowRaw>
        return Object.fromEntries(rows.map((r) => [r.key, parse(r.value_json)]))
      })

    const set: SettingsRepoShape["set"] = (key, value) =>
      q(() => {
        sqlite
          .prepare(
            `INSERT INTO settings (key, value_json) VALUES (?,?)
             ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`
          )
          .run(key, JSON.stringify(value ?? null))
      })

    const remove: SettingsRepoShape["remove"] = (key) =>
      q(() => {
        sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key)
      })

    return SettingsRepo.of({ get, all, set, remove })
  })
)
