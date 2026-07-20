import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core"
import { projects } from "./db.projects.js"

// exposures — opt-in reverse-proxy binding per project (unique per kind).
export const exposures = sqliteTable(
  "exposures",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // stable_url | tunnel | mdns
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    hostname: text("hostname"),
    configJson: text("config_json")
  },
  (t) => [unique("exposures_project_kind").on(t.projectId, t.kind)]
)

export type ExposureRow = typeof exposures.$inferSelect
