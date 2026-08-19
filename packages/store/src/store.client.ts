import { Context, Effect, Layer } from "effect"
import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { mkdirSync, readdirSync, unlinkSync } from "node:fs"
import * as schema from "./db.schema/db.index.js"
import { MIGRATIONS } from "./migrations/migrations.embedded.js"
import { MigrationError, StoreQueryError } from "./store.errors.js"

type Sqlite = Database.Database
type Db = BetterSQLite3Database<typeof schema>

// MATISA_DB pins the file exactly; otherwise the DB lives under the matisa
// root (MATISA_ROOT, default ~/.matisa) — the same resolution the engine's
// AppConfig performs, repeated here because the store must also open the right
// DB when run standalone (tests, one-off scripts).
const resolveDbPath = (): string =>
  process.env.MATISA_DB ??
  join(process.env.MATISA_ROOT ?? join(homedir(), ".matisa"), "matisa.db")

/** How many pre-migration snapshots to keep. A week of daily beta builds is
 *  roughly a week of schema changes; five is enough history to fall back
 *  through without the backups outgrowing the database they protect. */
const KEEP_BACKUPS = 5

// A copy of the database taken immediately before the first migration of a run
// is applied. Migrations are forward-only and there is no `down` — so without
// this, a migration that turns out to be wrong is unrecoverable for anyone who
// already ran it, and during a beta that is someone else's machine.
//
// VACUUM INTO rather than a file copy: it is atomic, and it reads through the
// WAL, so the snapshot includes committed transactions that a cp of the .db
// file alone would miss.
//
// A failure here must not block the migration. The backup is insurance, and
// refusing to start the engine because insurance could not be written trades a
// recoverable problem for an outage. The caller logs; the migration proceeds.
const backupBeforeMigrations = (sqlite: Sqlite, dbPath: string, upcoming: string): string => {
  const dir = dirname(dbPath)
  const name = basename(dbPath)
  const target = join(dir, `${name}.pre-${upcoming}-${Date.now()}.bak`)

  // VACUUM INTO takes no bind parameters, so the path is inlined; doubling any
  // single quote is what keeps a directory named O'Brien from ending the string.
  sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)

  // Prune oldest-first. Names carry the timestamp, and the prefix is fixed, so
  // lexicographic order is chronological order.
  const stale = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.pre-`) && f.endsWith(".bak"))
    .sort()
    .slice(0, -KEEP_BACKUPS)
  for (const f of stale) unlinkSync(join(dir, f))

  return target
}

// Forward-only migration ledger, embedded as strings (migrations.embedded.ts,
// generated from the .sql files) so the bundled engine carries its schema with
// it. Each entry is applied once, inside a single transaction, and recorded in
// schema_migrations.
const runMigrations = (sqlite: Sqlite, dbPath: string): Effect.Effect<void, MigrationError> =>
  Effect.gen(function* () {
    const pending = yield* Effect.try({
      try: () => {
        sqlite.exec(
          "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
        )
        const applied = sqlite.prepare("SELECT version FROM schema_migrations")
        const has = new Set(
          (applied.all() as ReadonlyArray<{ version: string }>).map((r) => r.version)
        )
        return { has, first: MIGRATIONS.find((m) => !has.has(m.version)) }
      },
      catch: (cause) => new MigrationError({ version: "pending", cause })
    })

    // Nothing to apply — the overwhelmingly common path, and it takes no
    // snapshot. A fresh database is skipped too: `has.size === 0` means every
    // migration is about to run against an empty file, and there is nothing in
    // it worth preserving.
    const first = pending.first
    if (first === undefined) return
    if (pending.has.size > 0) {
      yield* Effect.try(() => backupBeforeMigrations(sqlite, dbPath, first.version)).pipe(
        Effect.flatMap((path) => Effect.logInfo(`pre-migration snapshot → ${path}`)),
        Effect.catchAll((cause) =>
          Effect.logWarning(`pre-migration snapshot failed, continuing: ${String(cause)}`)
        )
      )
    }

    yield* applyMigrations(sqlite, pending.has)
  })

const applyMigrations = (
  sqlite: Sqlite,
  has: ReadonlySet<string>
): Effect.Effect<void, MigrationError> =>
  Effect.try({
    try: () => {
      for (const m of MIGRATIONS) {
        if (has.has(m.version)) continue
        const record = sqlite.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
        )
        sqlite.transaction(() => {
          sqlite.exec(m.sql)
          record.run(m.version, Date.now())
        })()
      }
    },
    catch: (cause) => new MigrationError({ version: "pending", cause })
  })

// ────────────────────────────────────────────────────────────────────────────
// Store — the single owner of the sqlite handle (sole-db-owner tenet). Only
// this package opens the DB; repositories run SQL through the handle it hands
// out. The handle is Scope-managed: acquire opens + migrates, release closes
// exactly once on shutdown/interrupt.
// ────────────────────────────────────────────────────────────────────────────

export interface StoreShape {
  /** Raw better-sqlite3 handle — repositories prepare/run against it. */
  readonly sqlite: Sqlite
  /** Schema-aware Drizzle client over the same handle. */
  readonly db: Db
  /** Run a synchronous unit of work atomically; a throw rolls back and becomes StoreQueryError. */
  readonly transaction: <A>(work: (sqlite: Sqlite) => A) => Effect.Effect<A, StoreQueryError>
}

export class Store extends Context.Tag("Store")<Store, StoreShape>() {}

export const StoreClientLive = Layer.scoped(
  Store,
  Effect.gen(function* () {
    const dbPath = resolveDbPath()
    mkdirSync(dirname(dbPath), { recursive: true })

    const sqlite = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(dbPath)),
      (handle) => Effect.sync(() => handle.close())
    )

    sqlite.pragma("journal_mode = WAL")
    sqlite.pragma("foreign_keys = ON")
    sqlite.pragma("busy_timeout = 5000")

    yield* runMigrations(sqlite, dbPath)

    const db = drizzle(sqlite, { schema })

    const transaction = <A>(work: (s: Sqlite) => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({
        try: () => sqlite.transaction(work)(sqlite),
        catch: (cause) => new StoreQueryError({ cause })
      })

    return Store.of({ sqlite, db, transaction })
  })
)
