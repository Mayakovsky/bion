import { pool, query, type Executor } from '../db/pool.js'
import { assertAcyclic } from './dag.js'
import type { Task } from './types.js'

export interface CreateTaskInput {
  id: string
  title: string
  description?: string
  owner?: string
  priority?: number
  dependencies?: string[]
  status?: Task['status']
  project?: string
}

async function loadEdges(): Promise<Map<string, string[]>> {
  const res = await query<{ id: string; dependencies: string[] }>(
    'SELECT id, dependencies FROM tasks',
  )
  const edges = new Map<string, string[]>()
  for (const row of res.rows) edges.set(row.id, row.dependencies)
  return edges
}

/**
 * Create a task. Validates that its dependencies keep the task graph acyclic (inv 14)
 * BEFORE inserting; throws CycleError otherwise.
 *
 * `ratified` is intentionally never written here — the runtime role lacks the column
 * privilege (directive-01 ruling 3). New tasks default to ratified=false.
 */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const deps = input.dependencies ?? []
  const existing = await loadEdges()
  assertAcyclic(input.id, deps, existing) // throws CycleError on a cycle

  const res = await query<Task>(
    `INSERT INTO tasks (id, title, description, owner, priority, status, dependencies, project)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, title, description, owner, priority, status, dependencies, ratified, project, branch, created, updated`,
    [
      input.id,
      input.title,
      input.description ?? '',
      input.owner ?? null,
      input.priority ?? 0,
      input.status ?? 'backlog',
      deps,
      input.project ?? null,
    ],
  )
  return res.rows[0]!
}

export interface ListTasksFilter {
  project?: string
  status?: Task['status']
  /** undefined = all (default) */
  ratified?: boolean
}

/** Filtered task listing for `bion task list`. */
export async function listTasks(filter: ListTasksFilter = {}, exec: Executor = pool()): Promise<Task[]> {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.project !== undefined) {
    params.push(filter.project)
    clauses.push(`project = $${params.length}`)
  }
  if (filter.status !== undefined) {
    params.push(filter.status)
    clauses.push(`status = $${params.length}`)
  }
  if (filter.ratified !== undefined) {
    params.push(filter.ratified)
    clauses.push(`ratified = $${params.length}`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const res = await exec.query<Task>(
    `SELECT id, title, description, owner, priority, status, dependencies, ratified, project, branch, created, updated
     FROM tasks ${where}
     ORDER BY priority DESC, created ASC`,
    params,
  )
  return res.rows
}

export async function getTask(id: string, exec: Executor = pool()): Promise<Task | null> {
  const res = await exec.query<Task>(
    `SELECT id, title, description, owner, priority, status, dependencies, ratified, project, branch, created, updated
     FROM tasks WHERE id = $1`,
    [id],
  )
  return res.rows[0] ?? null
}

/** Idempotent status transition (the state monitor uses this). */
export async function setTaskStatus(
  id: string,
  status: Task['status'],
  exec: Executor = pool(),
): Promise<Task | null> {
  const res = await exec.query<Task>(
    `UPDATE tasks SET status = $2, updated = now()
     WHERE id = $1 AND status IS DISTINCT FROM $2
     RETURNING id, title, description, owner, priority, status, dependencies, ratified, project, branch, created, updated`,
    [id, status],
  )
  if ((res.rowCount ?? 0) > 0) return res.rows[0]!
  return getTask(id, exec)
}

/**
 * Explicit task↔branch binding (directive-91) — record real work starting on a ratified task,
 * so `reactive.ts` can look the task up directly instead of guessing from the branch name.
 * Only binds a ratified task (mirrors `decide()`'s own "not-ratified-branch" gate in reactive.ts —
 * binding an unratified task's branch would just create a dead association nothing can dispatch
 * against). Returns null if the task doesn't exist or isn't ratified; doesn't throw, since a
 * caller running this as part of a normal "start work" step shouldn't crash on a bad task id.
 */
export async function bindBranch(
  id: string,
  branch: string,
  exec: Executor = pool(),
): Promise<Task | null> {
  const res = await exec.query<Task>(
    `UPDATE tasks SET branch = $2, updated = now()
     WHERE id = $1 AND ratified = true
     RETURNING id, title, description, owner, priority, status, dependencies, ratified, project, branch, created, updated`,
    [id, branch],
  )
  return res.rows[0] ?? null
}
