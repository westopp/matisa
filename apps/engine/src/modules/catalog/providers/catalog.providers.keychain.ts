import { Effect, Layer, Option, Redacted } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DEFAULT_SECRETS_PATH } from "../../../config/config.constants.js"
import { Keychain, KeychainError, type KeychainShape } from "./catalog.providers.keychain.types.js"

// ────────────────────────────────────────────────────────────────────────────
// NOT WIRED — POC stores env values (secrets included) directly in the DB with
// a display-only `secret` flag. This provider re-enters the layer graph when
// secure stores land (macOS Keychain / libsecret / Windows Credential Manager):
// values move out of the DB, rows carry only a ref resolved here at spawn time.
// ────────────────────────────────────────────────────────────────────────────

const readStore = (): Record<string, string> => {
  if (!existsSync(DEFAULT_SECRETS_PATH)) return {}
  try {
    return JSON.parse(readFileSync(DEFAULT_SECRETS_PATH, "utf8")) as Record<string, string>
  } catch {
    return {}
  }
}

const writeStore = (data: Record<string, string>): void => {
  mkdirSync(dirname(DEFAULT_SECRETS_PATH), { recursive: true })
  writeFileSync(DEFAULT_SECRETS_PATH, JSON.stringify(data), "utf8")
}

const make: KeychainShape = {
  set: (ref, value) =>
    Effect.try({
      try: () => {
        const store = readStore()
        store[ref] = Buffer.from(Redacted.value(value), "utf8").toString("base64")
        writeStore(store)
      },
      catch: (cause) => new KeychainError({ ref, errorMessage: String(cause) })
    }),
  get: (ref) =>
    Effect.try({
      try: () => {
        const store = readStore()
        const enc = store[ref]
        return enc === undefined
          ? Option.none<Redacted.Redacted<string>>()
          : Option.some(Redacted.make(Buffer.from(enc, "base64").toString("utf8")))
      },
      catch: (cause) => new KeychainError({ ref, errorMessage: String(cause) })
    }),
  delete: (ref) =>
    Effect.try({
      try: () => {
        const store = readStore()
        delete store[ref]
        writeStore(store)
      },
      catch: (cause) => new KeychainError({ ref, errorMessage: String(cause) })
    })
}

export const KeychainLive = Layer.effect(
  Keychain,
  Effect.gen(function* () {
    yield* Effect.logInfo(
      "STUB: keychain provider is file-backed (base64) — swap for the OS backend in production"
    )
    return Keychain.of(make)
  })
)
