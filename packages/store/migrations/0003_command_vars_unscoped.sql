-- 0003_command_vars_unscoped — a command's env vars are unconditional.
--
-- Scoping a command's own var to a context was a distinction without a use: the
-- var is configured ON the command, so every run of that command wants it. The
-- column is dropped rather than defaulted, so nothing can re-introduce a
-- conditional layer.
--
-- Collapse first: two rows may share a key across contexts, and the surviving
-- UNIQUE (command_id, key) would reject them. The context-scoped row wins,
-- being the more specific of the two.
DELETE FROM command_vars
WHERE context_id = ''
  AND EXISTS (
    SELECT 1 FROM command_vars other
    WHERE other.command_id = command_vars.command_id
      AND other.key = command_vars.key
      AND other.context_id <> ''
  );

-- Of several context-scoped rows for one key, keep the last written.
DELETE FROM command_vars
WHERE id NOT IN (SELECT MAX(id) FROM command_vars GROUP BY command_id, key);

CREATE TABLE command_vars_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  CONSTRAINT command_vars_unique UNIQUE (command_id, key)
);

INSERT INTO command_vars_new (id, command_id, key, value)
SELECT id, command_id, key, value FROM command_vars;

DROP TABLE command_vars;
ALTER TABLE command_vars_new RENAME TO command_vars;
