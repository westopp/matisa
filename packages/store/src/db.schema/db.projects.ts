import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

// projects — the persisted catalog entry. Nested core shapes (Command) are
// stored as JSON columns; ports/env/commands/exposures live in their own
// tables. $inferSelect is the raw row; repositories reassemble the core
// `Project` from it. NOTE: the DB retains a legacy `exposure_json` column
// (0001_init) that nothing reads — exposure state lives in `exposures`.
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  root: text("root").notNull(),
  /** process | docker | compose — which runner the supervisor uses. */
  kind: text("kind").notNull().default("process"),
  commandJson: text("command_json"),
  image: text("image"),
  composeFile: text("compose_file"),
  groupSlug: text("group_slug"),
  activeContextId: text("active_context_id"),
  /** Absolute path to the project's icon; the engine inlines it for clients. */
  pathToIcon: text("path_to_icon"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
})

export type ProjectRow = typeof projects.$inferSelect
export type NewProjectRow = typeof projects.$inferInsert
