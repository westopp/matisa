import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// events — append-only durable queue. `seq` is the autoincrement PK and IS the
// client cursor: clients pull events with seq strictly greater than the last
// they saw, and resume from there. Live delivery is a PubSub push; this table
// is the one-shot replay/backfill source. The only writer is EventsRepo.
export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    projectId: text("project_id").notNull(),
    topic: text("topic"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull()
  },
  (t) => [index("events_project_seq").on(t.projectId, t.seq)]
)

export type EventRow = typeof events.$inferSelect
