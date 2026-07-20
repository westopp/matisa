import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { projects } from "./db.projects.js"

// spawns — persisted pid/pgid/logPath so boot reconciliation can re-adopt
// survivors after an engine restart (state-is-truth: reap real exits, never
// poll kill(pid,0)). A live spawn has exitedAt null.
export const spawns = sqliteTable("spawns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  pid: integer("pid").notNull(),
  pgid: integer("pgid"),
  logPath: text("log_path"),
  startedAt: integer("started_at").notNull(),
  exitedAt: integer("exited_at"),
  exitCode: integer("exit_code")
})

export type SpawnRow = typeof spawns.$inferSelect
