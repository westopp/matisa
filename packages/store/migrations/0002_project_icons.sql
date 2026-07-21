-- 0002_project_icons — project artwork + a materialised base environment.
--
-- path_to_icon: an absolute path, not the bytes. The client is a browser
-- sandbox and cannot read file://, so the engine inlines it on demand
-- (fs.readIcon) — which also means swapping the file on disk is picked up
-- without touching the catalog.
ALTER TABLE projects ADD COLUMN path_to_icon TEXT;

-- `base` is the floor every environment inherits, so the UI shows it as a pill
-- like any other and a project can be pointed back at it. env.use requires the
-- row to exist, and until now it only appeared once someone set a base var —
-- seed it so selecting Base always works.
INSERT OR IGNORE INTO env_contexts (id, name, description)
VALUES ('base', 'base', 'Applies to every environment');
