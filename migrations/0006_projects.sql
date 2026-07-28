-- 0006_projects.sql — ordered project list for Auto Mode's pivot-on-block (Phase E3).
-- Lane: migration/owner. Additive.
--
-- The project ORDER is Forces-defined config (owner lane), like ratification — the runtime role
-- reads it but does not author the roadmap. A task's `project` groups it; Auto Mode walks projects
-- by ordinal, and within a project by priority, skipping blocked work (pivot-on-block).

BEGIN;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project text;

CREATE TABLE IF NOT EXISTS projects (
  id      text PRIMARY KEY,
  ordinal int     NOT NULL DEFAULT 0,
  active  boolean NOT NULL DEFAULT true
);

-- runtime: read the project list; may set a task's project (part of task authoring, not ratified).
GRANT SELECT ON projects TO bion_rw;
GRANT INSERT (project) ON tasks TO bion_rw;
GRANT UPDATE (project) ON tasks TO bion_rw;

COMMIT;
