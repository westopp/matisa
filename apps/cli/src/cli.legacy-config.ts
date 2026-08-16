import { Data, Effect } from "effect"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

// ────────────────────────────────────────────────────────────────────────────
// Reading the pre-engine config (`~/.config/matisa/services.ts`).
//
// Those files are TypeScript modules that import each other (`./ports`,
// `../types`) and compute values, so there is nothing to parse — they have to be
// EVALUATED. Bun does that in one step with no build, which is what the Swift
// app did too; the alternative is bundling a TypeScript loader into a CLI that
// is otherwise a plain esbuild bundle, for one command.
//
// The env block is the part that matters here, and its shape is the whole
// reason this import exists:
//
//   env: { PORT: "3000", dev: { NODE_ENV: "development" } }
//         ^^^^ string values are the BASE      ^^^^ object values are OVERLAYS
//
// The base/overlay split is exactly what the original import into the engine
// flattened away, merging each overlay into its own copy of the base. Reading it
// back out of the source is the only way to recover which variable belonged to
// which layer.
// ────────────────────────────────────────────────────────────────────────────

export interface LegacyContext {
  readonly name: string
  readonly vars: ReadonlyArray<{ readonly key: string; readonly value: string }>
}

export interface LegacyService {
  readonly name: string
  /** Top-level string values — applied to every environment of this project. */
  readonly base: ReadonlyArray<{ readonly key: string; readonly value: string }>
  /** Object-valued keys, in file order: `dev`, `test`, … */
  readonly contexts: ReadonlyArray<LegacyContext>
}

export class ConfigUnreadable extends Data.TaggedError("ConfigUnreadable")<{
  readonly path: string
  readonly reason: string
}> {}

/** Evaluated in a child process, not here: the config is arbitrary TypeScript
 *  that runs `join`, reads `PORTS`, and could do anything else — it belongs
 *  outside the CLI's own process, and its stdout is the only thing we consume. */
const EVAL = [
  "const mod = await import(process.env.MATISA_LEGACY_CONFIG);",
  "const services = mod.default?.services ?? mod.services ?? [];",
  "process.stdout.write(JSON.stringify(services));"
].join(" ")

const runBun = (entry: string): Effect.Effect<string, ConfigUnreadable> =>
  Effect.async<string, ConfigUnreadable>((resume) => {
    execFile(
      "bun",
      ["-e", EVAL],
      {
        env: { ...process.env, MATISA_LEGACY_CONFIG: entry },
        maxBuffer: 32 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const reason =
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "bun is not on PATH — the legacy config is TypeScript and needs bun to evaluate it"
              : stderr.trim() || error.message
          resume(Effect.fail(new ConfigUnreadable({ path: entry, reason })))
          return
        }
        resume(Effect.succeed(stdout))
      }
    )
  })

/** Split one service's `env` block into its base and its named overlays. Order
 *  is preserved from the source: JS keeps string-keyed insertion order, so the
 *  contexts come back in the order they were written. */
const splitEnv = (env: unknown): Pick<LegacyService, "base" | "contexts"> => {
  const base: Array<{ key: string; value: string }> = []
  const contexts: Array<LegacyContext> = []
  if (typeof env !== "object" || env === null) return { base, contexts }
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string") {
      base.push({ key, value })
      continue
    }
    if (typeof value !== "object" || value === null) continue
    const vars = Object.entries(value as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .map(([k, v]) => ({ key: k, value: v }))
    contexts.push({ name: key, vars })
  }
  return { base, contexts }
}

/** `dir` is the config directory (`~/.config/matisa`), not the file — the entry
 *  point has a fixed name and the per-project files are reached through it. */
export const readLegacyConfig = (
  dir: string
): Effect.Effect<ReadonlyArray<LegacyService>, ConfigUnreadable> =>
  Effect.gen(function* () {
    const entry = join(dir, "services.ts")
    if (!existsSync(entry)) {
      return yield* Effect.fail(
        new ConfigUnreadable({ path: entry, reason: "no services.ts in that directory" })
      )
    }
    const raw = yield* runBun(entry)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as ReadonlyArray<Record<string, unknown>>,
      catch: () =>
        new ConfigUnreadable({ path: entry, reason: "config did not evaluate to JSON" })
    })
    return parsed
      .filter((s) => typeof s["name"] === "string")
      .map((s): LegacyService => ({ name: s["name"] as string, ...splitEnv(s["env"]) }))
  })
