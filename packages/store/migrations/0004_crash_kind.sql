-- 0004_crash_kind — crash_history holds both halves of the failure vocabulary.
--
-- Until now only `crashed` (child exited non-zero) reached the table, so an
-- `errored` project — spawn refused, port held by something else, docker or
-- compose declined, restarts exhausted — left no durable record at all: the
-- reason lived in one toast and one activity line, and the Failures tab said
-- "nothing has crashed" while the project sat there red.
--
-- `kind` is the discriminant. It defaults to 'crash' because every row written
-- before this migration was a process crash, so existing history keeps its
-- meaning without a backfill.
ALTER TABLE crash_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'crash';

-- Newest-first per project is how every read hits this table (lifecycle.failures
-- orders by ts DESC, optionally filtered by project).
CREATE INDEX IF NOT EXISTS crash_history_project_ts ON crash_history (project_id, ts DESC);
