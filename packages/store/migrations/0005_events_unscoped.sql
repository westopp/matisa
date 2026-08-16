-- 0005_events_unscoped — the durable queue accepts events that name no project.
--
-- project_id was NOT NULL because every event the engine could emit was about a
-- project. Configuration that belongs to no single project — a group renamed,
-- an env context created, a project's saved commands edited — therefore had
-- nowhere to go, and the engine simply did not emit it: a CLI `group set` left
-- an open desktop showing the old title until it reconnected.
--
-- Nullable rather than a sentinel id. A sentinel would satisfy the column and
-- lie to every reader of it, starting with the events_project_seq index and the
-- `--project` filter, which would then have to know which fake id to exclude.
--
-- sqlite cannot drop a NOT NULL in place, so this is the standard rebuild. The
-- explicit seq values carry over, which is what keeps existing client cursors
-- meaningful across the migration — a cursor is only a promise if the numbers
-- behind it do not move.
CREATE TABLE events_new (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  project_id   TEXT,
  topic        TEXT,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

INSERT INTO events_new (seq, ts, project_id, topic, type, payload_json)
SELECT seq, ts, project_id, topic, type, payload_json FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX IF NOT EXISTS events_project_seq ON events(project_id, seq);
