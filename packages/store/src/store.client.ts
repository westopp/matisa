import { Context, Effect, Layer } from "effect"
import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { mkdirSync, readFileSync } from "node:fs"
import * as schema from "./db.schema/db.index.js"
import { MigrationError, StoreQueryError } from "./store.errors.js"

type Sqlite = Database.Database
type Db = BetterSQLite3Database<typeof schema>

const DEFAULT_DB = "/Users/thulanekhumalo/Desktop/dev/tools/matisa/.matisa/matisa.db"

const resolveDbPath = (): string => process.env.MATISA_DB ?? DEFAULT_DB

// Forward-only migration ledger. Each entry is applied once, inside a single
// transaction, and recorded in schema_migrations. Add new files here in order.
const MIGRATIONS: ReadonlyArray<{ readonly version: string; readonly file: string }> = [
  { version: "0001_init", file: "0001_init.sql" }
]

const migrationsDir = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "migrations")

const runMigrations = (sqlite: Sqlite): Effect.Effect<void, MigrationError> =>
  Effect.try({
    try: () => {
      sqlite.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
      )
      const applied = sqlite.prepare("SELECT version FROM schema_migrations")
      const has = new Set(
        (applied.all() as ReadonlyArray<{ version: string }>).map((r) => r.version)
      )
      const dir = migrationsDir()
      for (const m of MIGRATIONS) {
        if (has.has(m.version)) continue
        const sql = readFileSync(join(dir, m.file), "utf8")
        const record = sqlite.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
        )
        sqlite.transaction(() => {
          sqlite.exec(sql)
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

    yield* runMigrations(sqlite)

    const db = drizzle(sqlite, { schema })

    const transaction = <A>(work: (s: Sqlite) => A): Effect.Effect<A, StoreQueryError> =>
      Effect.try({
        try: () => sqlite.transaction(work)(sqlite),
        catch: (cause) => new StoreQueryError({ cause })
      })

    return Store.of({ sqlite, db, transaction })
  })
)
