import { Context, Data, type Effect, type Option, type Redacted } from "effect"

// ────────────────────────────────────────────────────────────────────────────
// The Keychain tag. The DB stores only a secret `ref`; this tag is the sole path
// to the plaintext value, which is Redacted end-to-end so it can never leak into
// a log or span (secrets-never-in-plaintext tenet).
// ────────────────────────────────────────────────────────────────────────────

export class KeychainError extends Data.TaggedError("KeychainError")<{
  readonly ref: string
  readonly errorMessage: string
}> {}

export interface KeychainShape {
  readonly set: (ref: string, value: Redacted.Redacted<string>) => Effect.Effect<void, KeychainError>
  readonly get: (ref: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KeychainError>
  readonly delete: (ref: string) => Effect.Effect<void, KeychainError>
}

export class Keychain extends Context.Tag("Keychain")<Keychain, KeychainShape>() {}
