import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { projects } from "./db.projects.js"

// crash_history — durable failure records (exit code / signal / summary / log
// tail). Fixes the POC's in-memory-only launch failures: a crash survives an
// engine restart.
export const crashHistory = sqliteTable("crash_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  ts: integer("ts").notNull(),
  exitCode: integer("exit_code"),
  signal: text("signal"),
  summary: text("summary"),
  logTail: text("log_tail")
})

export type CrashRow = typeof crashHistory.$inferSelect
