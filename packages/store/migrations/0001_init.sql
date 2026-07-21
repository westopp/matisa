-- 0001_init — initial matisa store schema.
-- Applied by store.client at acquire time (before the socket opens), tracked in
-- schema_migrations. Forward-only. events.seq AUTOINCREMENT is the client cursor.

CREATE TABLE IF NOT EXISTS groups (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  notes        TEXT,
  path_to_icon TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  root              TEXT NOT NULL,
  -- kind discriminates the runner: process (command_json), docker (image),
  -- compose (compose_file). Field presence enforced by core Schema.
  kind              TEXT NOT NULL DEFAULT 'process',
  command_json      TEXT,
  image             TEXT,
  compose_file      TEXT,
  group_slug        TEXT REFERENCES groups(slug) ON DELETE SET NULL,
  active_context_id TEXT,
  exposure_json     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL UNIQUE,
  protocol    TEXT NOT NULL DEFAULT 'tcp',
  description  TEXT
);
CREATE INDEX IF NOT EXISTS ports_project ON ports(project_id);

CREATE TABLE IF NOT EXISTS env_contexts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS env_vars (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL REFERENCES env_contexts(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  is_secret  INTEGER NOT NULL DEFAULT 0,
  value      TEXT NOT NULL,
  CONSTRAINT env_vars_context_key UNIQUE (context_id, key)
);

CREATE TABLE IF NOT EXISTS commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  command    TEXT NOT NULL,
  CONSTRAINT commands_project_name UNIQUE (project_id, name)
);

-- Per-command env overrides. context_id '' = the command's base layer
-- (NOT NULL so the UNIQUE constraint actually dedupes; sqlite treats NULLs
-- as distinct). Precedence at run time:
--   project base -> project active ctx -> command base -> command active ctx
CREATE TABLE IF NOT EXISTS command_vars (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  CONSTRAINT command_vars_unique UNIQUE (command_id, context_id, key)
);

CREATE TABLE IF NOT EXISTS exposures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  hostname    TEXT,
  config_json TEXT,
  CONSTRAINT exposures_project_kind UNIQUE (project_id, kind)
);

CREATE TABLE IF NOT EXISTS runtime_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  state      TEXT NOT NULL,
  pid        INTEGER,
  session_id TEXT,
  exit_code  INTEGER,
  health     TEXT,
  since      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spawns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pid        INTEGER NOT NULL,
  pgid       INTEGER,
  log_path   TEXT,
  started_at INTEGER NOT NULL,
  exited_at  INTEGER,
  exit_code  INTEGER
);
CREATE INDEX IF NOT EXISTS spawns_live ON spawns(project_id) WHERE exited_at IS NULL;

CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  project_id   TEXT NOT NULL,
  topic        TEXT,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project_seq ON events(project_id, seq);

CREATE TABLE IF NOT EXISTS crash_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  exit_code  INTEGER,
  signal     TEXT,
  summary    TEXT,
  log_tail   TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
