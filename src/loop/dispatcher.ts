import { query } from '../db/pool.js'
import { setTaskStatus } from '../core/tasks.js'
import type { AgentAdapter, DispatchResult } from '../adapters/types.js'
import type { Task } from '../core/types.js'

// Dispatcher — pulls from the RATIFIED backlog only (auto-wake envelope, FDQ-B3 / inv 13),
// respects DAG dependencies (a task is dispatchable only when every dependency is 'done'),
// and assigns work to Kov. It never dispatches outside ratified movement scope.

/** Ratified, un-started tasks whose dependencies all exist and are 'done', hottest first. */
export async function selectDispatchable(): Promise<Task[]> {
  const res = await query<Task>(
    `SELECT t.id, t.title, t.description, t.owner, t.priority, t.status,
            t.dependencies, t.ratified, t.project, t.created, t.updated
     FROM tasks t
     WHERE t.ratified = true
       AND t.status IN ('backlog','ready')
       AND NOT EXISTS (
         SELECT 1 FROM unnest(t.dependencies) AS dep
         LEFT JOIN tasks d ON d.id = dep
         WHERE d.id IS NULL OR d.status <> 'done'
       )
     ORDER BY t.priority DESC, t.created`,
  )
  return res.rows
}

export interface DispatchOutcome {
  task: Task
  dispatch: DispatchResult
}

function taskPacket(task: Task): string {
  return [
    `# Task ${task.id}`,
    '',
    `**Title:** ${task.title}`,
    task.description ? `\n${task.description}` : '',
    '',
    task.dependencies.length ? `Depends on: ${task.dependencies.join(', ')}` : 'Depends on: (none)',
    '',
    'Dispatched by Bion from the ratified backlog. Commit within scope proceeds under the',
    'feature-branch delegation; push/merge/tag/deploy/spend stop at the Forces gate.',
    '',
  ].join('\n')
}

/**
 * Dispatch the top dispatchable ratified task to Kov: mark it in_progress and route the task
 * packet through Bion. Returns null when nothing is dispatchable. Idempotent across calls: a
 * task already in_progress is excluded from selection, so it won't be re-dispatched.
 */
export async function dispatchNext(kov: AgentAdapter): Promise<DispatchOutcome | null> {
  const [next] = await selectDispatchable()
  if (!next) return null

  const started = (await setTaskStatus(next.id, 'in_progress')) ?? next
  const dispatch = await kov.dispatch({
    sender: 'bion',
    recipient: 'kov',
    thread: next.id,
    summary: `task ${next.id}: ${next.title}`,
    body: taskPacket(started),
    origin: 'bion',
    type: 'task',
  })
  return { task: started, dispatch }
}
