import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { projects } from "./db.projects.js"

// crash_history — durable failure records (exit code / signal / summary / log
// tail). Fixes the POC's in-memory-only launch failures: a crash survives an
// engine restart.
//
// `kind` splits the two failures the FSM distinguishes: 'crash' (the child ran
// and exited non-zero) and 'error' (the engine never got it running — spawn
// refused, port held, docker declined, restarts exhausted). It defaults to
// 'crash' because that is what every row written before the column existed was.
export const crashHistory = sqliteTable("crash_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  ts: integer("ts").notNull(),
  kind: text("kind", { enum: ["crash", "error"] })
    .notNull()
    .default("crash"),
  exitCode: integer("exit_code"),
  signal: text("signal"),
  summary: text("summary"),
  logTail: text("log_tail")
})

export type CrashRow = typeof crashHistory.$inferSelect
