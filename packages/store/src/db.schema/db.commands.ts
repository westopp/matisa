import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core"
import { projects } from "./db.projects.js"

// commands — per-project named ad-hoc commands (name unique per project).
export const commands = sqliteTable(
  "commands",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    command: text("command").notNull()
  },
  (t) => [unique("commands_project_name").on(t.projectId, t.name)]
)

export type CommandRow = typeof commands.$inferSelect
