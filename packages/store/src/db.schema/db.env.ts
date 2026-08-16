import { sqliteTable, text, integer, unique, index } from "drizzle-orm/sqlite-core"
import { projects } from "./db.projects.js"

// env_contexts — a named set of env vars belonging to ONE project ("dev",
// "staging"). There is no unparented context and no installation-wide layer:
// project_id is NOT NULL, so every variable in the database is reachable by
// exactly one project's spawns.
//
// `name` is unique per project rather than globally, which is what lets every
// project have its own "dev". The id stays globally unique — it is the primary
// key and the single argument the CLI addresses a context by.
export const envContexts = sqliteTable(
  "env_contexts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The project's always-applied layer. Exactly one per project (enforced by
     *  a partial unique index in 0006); created with the project, and neither
     *  renamable nor deletable. */
    isBase: integer("is_base", { mode: "boolean" }).notNull().default(false),
    description: text("description")
  },
  (t) => [
    unique("env_contexts_project_name").on(t.projectId, t.name),
    index("env_contexts_project").on(t.projectId)
  ]
)

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
