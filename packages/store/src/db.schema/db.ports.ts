import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { projects } from "./db.projects.js"

// ports — strict host-port uniqueness: `number` is globally UNIQUE, so a
// colliding write is rejected by SQLite and surfaced as PortConflict.
export const ports = sqliteTable("ports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  number: integer("number").notNull().unique(),
  protocol: text("protocol").notNull().default("tcp"),
  description: text("description")
})

export type PortRow = typeof ports.$inferSelect
