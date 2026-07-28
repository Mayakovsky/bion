import pg from 'pg'
import { env } from '../src/env.js'

const { Client } = pg

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
