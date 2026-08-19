-- 0010_task_branch_binding.sql — directive-91: explicit task↔branch binding, replacing
-- reactive.ts's `bion/<taskId>` convention-guessing as the only way to find a task from a branch.
-- Lane: migration/owner. Additive.
--
-- `grey`'s branches never follow bion's own `bion/<taskId>` naming culture — there's no task ID
-- embedded in them at all. Recording the real association explicitly when work actually starts
-- (rather than inferring it from a string) is what makes reactive dispatch usable outside bion's
-- own repo. Nullable: most tasks won't have a bound branch until real work begins.

BEGIN;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS branch text;

-- bion_rw already holds INSERT/UPDATE on the other mutable columns (0002_grants.sql) — `ratified`
-- is deliberately excluded there and stays excluded here; `branch` joins the mutable set alongside
-- title/description/owner/priority/status/dependencies. Column grants are additive per statement,
-- so this doesn't touch or need to restate the existing grant.
GRANT UPDATE (branch) ON tasks TO bion_rw;

-- Real lookup pattern this exists for: `SELECT ... FROM tasks WHERE branch = $1 AND ratified = true`.
CREATE INDEX IF NOT EXISTS tasks_branch_idx ON tasks (branch) WHERE branch IS NOT NULL;

COMMIT;
