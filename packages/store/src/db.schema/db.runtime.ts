import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { projects } from "./db.projects.js"

// runtime_state — one row per project holding the last-known FSM state. This is
// what a client snapshot reads; the supervisor rewrites it on every transition.
export const runtimeState = sqliteTable("runtime_state", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  pid: integer("pid"),
  sessionId: text("session_id"),
  exitCode: integer("exit_code"),
  health: text("health"),
  since: integer("since").notNull()
})

export type RuntimeStateRow = typeof runtimeState.$inferSelect
