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

// command_vars — per-command env overrides, injected on every run of the
// command they belong to. One value per key per command; nothing to scope.
export const commandVars = sqliteTable(
  "command_vars",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    commandId: integer("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull()
  },
  (t) => [unique("command_vars_unique").on(t.commandId, t.key)]
)

export type CommandVarRow = typeof commandVars.$inferSelect
