import { sqliteTable, text } from "drizzle-orm/sqlite-core"

// groups — standalone organizational buckets; projects reference them via
// projects.group_slug (ON DELETE SET NULL). Presentational only.
export const groups = sqliteTable("groups", {
  slug: text("slug").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  notes: text("notes"),
  pathToIcon: text("path_to_icon")
})

export type GroupRow = typeof groups.$inferSelect
