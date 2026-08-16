-- 0006_env_project_scoped — environments belong to a project, and only to one.
--
-- Until now env_contexts was a global table: `name` was UNIQUE across the whole
-- installation and no column said which project a context belonged to. Two
-- consequences, both wrong:
--
--   * the context whose id is 'base' was injected into EVERY spawn, so a var set
--     there landed in every project's process environment;
--   * `env.use` accepted any context id for any project, so one project could be
--     pointed at another's variables.
--
-- Both disappear here. Every context now names its project, every project owns
-- exactly one `is_base` context (its always-applied layer), and `name` is unique
-- only within a project — which is what lets every project have its own "dev"
-- and "test" rather than the `<project>-test` naming the import had to invent.
--
-- WHAT THIS MIGRATION DOES NOT DO: split the flattened contexts back into base +
-- overlay. The import merged each project's base vars into both of its contexts,
-- so `seethis-server` and `seethis-server-test` are near-identical 25-key copies.
-- Undoing that needs the original config files, not SQL, so it belongs to the
-- importer. This migration is purely structural: the same variables reach the
-- same spawns afterwards, they just can no longer reach anyone else's.
--
-- ORDER OF THE REBUILD IS LOAD-BEARING. store.client sets `foreign_keys = ON`
-- before migrations run, and PRAGMA cannot be changed from inside the
-- transaction the runner wraps each migration in. Two things follow. First, with
-- FKs on, DROP TABLE fires ON DELETE actions — so dropping env_contexts while
-- env_vars still references it would CASCADE every variable in the database into
-- oblivion; env_vars is rebuilt and dropped FIRST, leaving nothing pointing at
-- env_contexts by the time it goes. Second, nothing may be inserted into the old
-- env_vars naming a context that exists only in env_contexts_new — its foreign
-- key still names the old table and would reject the row. Do not reorder these
-- statements.

CREATE TABLE env_contexts_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- The project's always-applied layer. Exactly one per project (partial unique
  -- index below), created with the project, never renamed or deleted.
  is_base     INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  CONSTRAINT env_contexts_project_name UNIQUE (project_id, name)
);

-- 1. Every project gets its base. `<name>-base` keeps the id readable in the DB
--    and in CLI arguments; project names are unique so two projects cannot
--    collide with each other, and the uuid form is the escape hatch for the case
--    where an imported context is already sitting on that id.
INSERT INTO env_contexts_new (id, project_id, name, is_base, description)
SELECT
  CASE
    WHEN EXISTS (SELECT 1 FROM env_contexts e WHERE e.id = p.name || '-base')
      THEN 'base-' || p.id
    ELSE p.name || '-base'
  END,
  p.id,
  'base',
  1,
  NULL
FROM projects p;

-- 2. Re-parent the imported contexts, keeping their current names — renaming
--    them to dev/test is a claim about what they contain, and only the importer
--    reading the original config can make that claim honestly.
--
--    Exact name match runs first so a context named after a project always lands
--    on that project, and only what is left is offered to the `-test` rule —
--    otherwise a project literally named `foo-test` would fight with project
--    `foo` over the same context row.
INSERT INTO env_contexts_new (id, project_id, name, is_base, description)
SELECT c.id, p.id, c.name, 0, c.description
FROM env_contexts c
JOIN projects p ON p.name = c.name;

INSERT INTO env_contexts_new (id, project_id, name, is_base, description)
SELECT c.id, p.id, c.name, 0, c.description
FROM env_contexts c
JOIN projects p ON p.name = substr(c.name, 1, length(c.name) - 5)
WHERE c.name LIKE '%-test'
  AND c.id NOT IN (SELECT id FROM env_contexts_new);

-- 3. Contexts matching no project have nowhere to go, and a forward-only
--    migration that silently destroys variables is not one you can trust with
--    secrets. Park them, name included, so what was dropped stays answerable.
--    Nothing reads this table; drop it in a later migration once it is empty.
--
--    'base' is excluded: it is not orphaned, it is redistributed in step 5.
CREATE TABLE IF NOT EXISTS env_orphaned_vars (
  context_id   TEXT NOT NULL,
  context_name TEXT NOT NULL,
  key          TEXT NOT NULL,
  is_secret    INTEGER NOT NULL DEFAULT 0,
  value        TEXT NOT NULL,
  orphaned_at  INTEGER NOT NULL
);

INSERT INTO env_orphaned_vars (context_id, context_name, key, is_secret, value, orphaned_at)
SELECT c.id, c.name, v.key, v.is_secret, v.value, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM env_contexts c
JOIN env_vars v ON v.context_id = c.id
WHERE c.id <> 'base'
  AND c.id NOT IN (SELECT id FROM env_contexts_new);

-- 4. Rebuild env_vars against the new contexts, keeping only rows whose context
--    survived. This is also what makes the drops below safe (see the header).
CREATE TABLE env_vars_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL REFERENCES env_contexts_new(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  is_secret  INTEGER NOT NULL DEFAULT 0,
  value      TEXT NOT NULL,
  CONSTRAINT env_vars_context_key UNIQUE (context_id, key)
);

INSERT INTO env_vars_new (id, context_id, key, is_secret, value)
SELECT v.id, v.context_id, v.key, v.is_secret, v.value
FROM env_vars v
WHERE v.context_id IN (SELECT id FROM env_contexts_new);

-- 5. The old global base applied to everything, so preserving its meaning means
--    copying it into every project's base rather than keeping it anywhere. OR
--    IGNORE because a project's own context may already define the same key —
--    and it won, being the more specific layer, before this migration too.
INSERT OR IGNORE INTO env_vars_new (context_id, key, is_secret, value)
SELECT b.id, v.key, v.is_secret, v.value
FROM env_vars v
CROSS JOIN env_contexts_new b
WHERE v.context_id = 'base' AND b.is_base = 1;

-- env_vars is referenced by nothing, so this drop fires no cascade. It has to
-- happen before env_contexts goes.
DROP TABLE env_vars;
DROP TABLE env_contexts;

-- Renaming the contexts table first lets SQLite rewrite env_vars_new's foreign
-- key to point at `env_contexts`; renaming the other way round would leave the
-- reference naming a table that no longer exists.
ALTER TABLE env_contexts_new RENAME TO env_contexts;
ALTER TABLE env_vars_new RENAME TO env_vars;

CREATE UNIQUE INDEX env_contexts_one_base ON env_contexts(project_id) WHERE is_base = 1;
CREATE INDEX env_contexts_project ON env_contexts(project_id);

-- A project whose active context was dropped as an orphan would otherwise keep a
-- pointer to a row that no longer exists; one whose active context was
-- re-parented elsewhere would keep spawning with another project's variables —
-- the exact bug this migration exists to close. Detach both.
UPDATE projects
SET active_context_id = NULL, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE active_context_id IS NOT NULL
  AND active_context_id NOT IN (
    SELECT id FROM env_contexts WHERE env_contexts.project_id = projects.id
  );
