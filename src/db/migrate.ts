import pg from 'pg'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../env.js'

const { Pool } = pg
const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations')

/**
 * Apply pending SQL migrations on the owner lane (bion_owner), in filename order.
 * Idempotent: each file is recorded in schema_migrations and skipped if already applied.
 * Each migration file manages its own BEGIN/COMMIT.
 */
export async function runMigrations(): Promise<string[]> {
  const migratePool = new Pool({ connectionString: env.migrateUrl, max: 2 })
  const applied: string[] = []
  try {
    await migratePool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      const done = await migratePool.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1',
        [file],
      )
      if ((done.rowCount ?? 0) > 0) continue

      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8')
      await migratePool.query(sql)
      await migratePool.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file],
      )
      applied.push(file)
    }
    return applied
  } finally {
    await migratePool.end()
  }
}

// Allow `tsx src/db/migrate.ts` as a CLI (no-op when imported, e.g. by test globalSetup).
const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  runMigrations()
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations')
      process.exit(0)
    })
    .catch((err) => {
      console.error('migration failed:', err.message)
      process.exit(1)
    })
}
