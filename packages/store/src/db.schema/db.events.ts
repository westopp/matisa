import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// events — append-only durable queue. `seq` is the autoincrement PK and IS the
// client cursor: clients pull events with seq strictly greater than the last
// they saw, and resume from there. Live delivery is a PubSub push; this table
// is the one-shot replay/backfill source. The only writer is EventsRepo.
//
// project_id is nullable: config_changed events describe a group, an env
// context or a saved-command set, none of which belong to a project. A NULL
// there means "not about one project", and the `--project` filter excludes
// those rows for free rather than having to know a sentinel.
export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    projectId: text("project_id"),
    topic: text("topic"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull()
  },
  (t) => [index("events_project_seq").on(t.projectId, t.seq)]
)

export type EventRow = typeof events.$inferSelect
