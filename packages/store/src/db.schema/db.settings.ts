import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

// settings — key→json bag (active env context, backoff overrides, prefs).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull()
})

// schema_migrations — forward-only applied-version ledger, checked by
// store.client at acquire time before the socket opens.
export const schemaMigrations = sqliteTable("schema_migrations", {
  version: text("version").primaryKey(),
  appliedAt: integer("applied_at").notNull()
})

export type SettingRow = typeof settings.$inferSelect
export type MigrationRow = typeof schemaMigrations.$inferSelect
