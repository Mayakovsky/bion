import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { env, parseDbUrl, query, createTask } from '../src/index.js'

const INSUFFICIENT_PRIVILEGE = '42501'
const REVENUE_TABLES = [
  'wpv_claims',
  'wpv_verifications',
  'wpv_whitepapers',
  'grey_pipeline',
  'grey_two',
]

// Plane-boundary is a credential boundary (spec §3.1). These assertions prove the runtime
// role resolves ONLY to the local, isolated bion DB with no path to the revenue plane.
describe('plane isolation', () => {
  // Under `vitest run` this resolves to bion_test, not bion (directive-23 Part A test isolation)
  // — same cluster/port/role, isolated database.
  it('BION_DATABASE_URL points only at the local bion(_test) DB as bion_rw', () => {
    const u = parseDbUrl(env.databaseUrl)
    expect(['localhost', '127.0.0.1']).toContain(u.host)
    expect(u.port).toBe('5433')
    expect(u.database).toBe('bion_test')
    expect(u.user).toBe('bion_rw')
  })

  it('connects to database "bion_test" as a non-superuser', async () => {
    const res = await query<{ db: string; su: string }>(
      `SELECT current_database() AS db, current_setting('is_superuser') AS su`,
    )
    expect(res.rows[0]!.db).toBe('bion_test')
    expect(res.rows[0]!.su).toBe('off')
  })

  it('has no revenue-plane tables and no cross-DB extensions', async () => {
    for (const t of REVENUE_TABLES) {
      const res = await query<{ oid: string | null }>('SELECT to_regclass($1) AS oid', [
        `public.${t}`,
      ])
      expect(res.rows[0]!.oid, `revenue table ${t} must not exist`).toBeNull()
    }
    const ext = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_extension WHERE extname IN ('dblink','postgres_fdw')`,
    )
    expect(ext.rows[0]!.n).toBe('0')
  })
})

// inv 13 / directive-01 ruling 3: Bion (bion_rw) can never set tasks.ratified.
describe('ratification is Forces-gated at the credential level', () => {
  it('new tasks default to ratified=false', async () => {
    const id = `t-${randomUUID()}`
    const t = await createTask({ id, title: 'unratified' })
    expect(t.ratified).toBe(false)
  })

  it('bion_rw cannot UPDATE tasks.ratified', async () => {
    const id = `t-${randomUUID()}`
    await createTask({ id, title: 'try to self-ratify' })
    await expect(
      query('UPDATE tasks SET ratified = true WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
  })

  it('bion_rw cannot INSERT a task with ratified set', async () => {
    const id = `t-${randomUUID()}`
    await expect(
      query('INSERT INTO tasks (id, title, ratified) VALUES ($1, $2, true)', [id, 'sneaky']),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
  })
})
