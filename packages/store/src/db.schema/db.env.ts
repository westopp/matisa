import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core"

// env_contexts — a named, reusable set of env vars ("dev", "staging").
export const envContexts = sqliteTable("env_contexts", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description")
})

// env_vars — one row per key within a context. POC: `value` holds every var,
// secrets included; `isSecret` is a display hint (masked in listings). A
// keychain-backed store replaces plaintext secrets post-POC.
export const envVars = sqliteTable(
  "env_vars",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contextId: text("context_id")
      .notNull()
      .references(() => envContexts.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(false),
    value: text("value").notNull()
  },
  (t) => [unique("env_vars_context_key").on(t.contextId, t.key)]
)

export type EnvContextRow = typeof envContexts.$inferSelect
export type EnvVarRow = typeof envVars.$inferSelect
