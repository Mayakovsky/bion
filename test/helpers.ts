import pg from 'pg'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { env } from '../src/env.js'
import { repoRoot } from '../src/paths.js'

const { Client } = pg

/**
 * Run an owner-lane shell script under scripts/ (BION_MIGRATE_URL) and return its stdout.
 * Used to round-trip-test the actual .sh artifacts (create-project.sh, ratify-project.sh),
 * not a TS re-implementation of their SQL — the point is proving the real script works.
 */
export function runOwnerScript(script: string, args: string[]): string {
  return execFileSync('bash', [join(repoRoot(), 'scripts', script), ...args], {
    env: { ...process.env, BION_MIGRATE_URL: env.migrateUrl },
    encoding: 'utf8',
  })
}

/**
 * Ratify a task via the owner/Forces lane (BION_MIGRATE_URL). Mirrors scripts/ratify-task.sh.
 * The runtime role (bion_rw) cannot do this — proven in isolation.test.ts — so tests that need
 * a ratified backlog use this owner-lane path, exactly as Forces would.
 */
export async function ratifyAsForces(taskId: string): Promise<void> {
  const client = new Client({ connectionString: env.migrateUrl })
  await client.connect()
  try {
    await client.query('UPDATE tasks SET ratified = true, updated = now() WHERE id = $1', [taskId])
  } finally {
    await client.end()
  }
}

/** Seed a project (owner/Forces lane — the ordered project list is Forces-defined config). */
export async function seedProject(id: string, ordinal: number): Promise<void> {
  const client = new Client({ connectionString: env.migrateUrl })
  await client.connect()
  try {
    await client.query(
      `INSERT INTO projects (id, ordinal, active) VALUES ($1, $2, true)
       ON CONFLICT (id) DO UPDATE SET ordinal = EXCLUDED.ordinal, active = true`,
      [id, ordinal],
    )
  } finally {
    await client.end()
  }
}

/** Delete scratch tasks (owner/Forces lane — bion_rw has no DELETE grant on tasks). Test teardown only. */
export async function deleteTasksAsForces(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return
  const client = new Client({ connectionString: env.migrateUrl })
  await client.connect()
  try {
    await client.query('DELETE FROM tasks WHERE id = ANY($1)', [taskIds])
  } finally {
    await client.end()
  }
}

/** Delete a scratch project (owner/Forces lane — bion_rw has no DELETE grant on projects). Test teardown only. */
export async function deleteProjectAsForces(id: string): Promise<void> {
  const client = new Client({ connectionString: env.migrateUrl })
  await client.connect()
  try {
    await client.query('DELETE FROM projects WHERE id = $1', [id])
  } finally {
    await client.end()
  }
}
