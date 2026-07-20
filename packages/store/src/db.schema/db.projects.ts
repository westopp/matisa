import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

// projects — the persisted catalog entry. Nested core shapes (Command,
// Exposure) are stored as JSON columns; ports/env/commands/exposures live in
// their own tables. $inferSelect is the raw row; repositories reassemble the
// core `Project` from it.
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  root: text("root").notNull(),
  commandJson: text("command_json").notNull(),
  activeContextId: text("active_context_id"),
  exposureJson: text("exposure_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
})

export type ProjectRow = typeof projects.$inferSelect
export type NewProjectRow = typeof projects.$inferInsert
