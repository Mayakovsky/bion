import { query } from '../db/pool.js'
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
    `INSERT INTO tasks (id, title, description, owner, priority, status, dependencies)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, title, description, owner, priority, status, dependencies, ratified, created, updated`,
    [
      input.id,
      input.title,
      input.description ?? '',
      input.owner ?? null,
      input.priority ?? 0,
      input.status ?? 'backlog',
      deps,
    ],
  )
  return res.rows[0]!
}

export async function getTask(id: string): Promise<Task | null> {
  const res = await query<Task>(
    `SELECT id, title, description, owner, priority, status, dependencies, ratified, created, updated
     FROM tasks WHERE id = $1`,
    [id],
  )
  return res.rows[0] ?? null
}

/** Idempotent status transition (Phase C uses this from the state monitor). */
export async function setTaskStatus(id: string, status: Task['status']): Promise<Task | null> {
  const res = await query<Task>(
    `UPDATE tasks SET status = $2, updated = now()
     WHERE id = $1 AND status IS DISTINCT FROM $2
     RETURNING id, title, description, owner, priority, status, dependencies, ratified, created, updated`,
    [id, status],
  )
  if ((res.rowCount ?? 0) > 0) return res.rows[0]!
  return getTask(id)
}
