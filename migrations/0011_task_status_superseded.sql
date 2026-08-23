-- 0011_task_status_superseded.sql — add a genuine terminal `superseded` status (directive-126).
-- Lane: migration/owner (bion_owner). Additive only.
--
-- `status='blocked'` was being overloaded for two real, different meanings: "temporarily can't
-- proceed, waiting on a dependency" (its honest use everywhere else, e.g. e2-cd) versus
-- "permanently dead by design, will never be picked, don't revive" (e3-b..e3-f, retitled
-- SUPERSEDED 2026-08-08 per directive-26 but left at status='blocked' for lack of a real terminal
-- value). `superseded` makes that distinction structural instead of title-text-only. Excluded from
-- selectAutoWork()'s selection identically to `blocked` (that filter is `status IN
-- ('backlog','ready')` — any value outside that set is already excluded, no code change needed).

BEGIN;

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('backlog','ready','in_progress','blocked','done','failed','superseded'));

COMMIT;
