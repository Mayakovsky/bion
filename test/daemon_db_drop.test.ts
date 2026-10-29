import { describe, it, expect } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../src/env.js'
import { pool, query, isConnectionError } from '../src/db/pool.js'
import { runDaemon, readHeartbeat } from '../src/index.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Terminate every OTHER bion_rw backend on the test DB, from a separate bion_rw connection (a role
 *  may terminate its own role's backends; bion_owner may not, and grants are not ours to change).
 *  A real server-side close, which is what a Postgres shutdown does to its clients (57P01). */
async function killRuntimeBackends(): Promise<number> {
  const owner = new pg.Client({ connectionString: env.databaseUrl })
  await owner.connect()
  try {
    const r = await owner.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()`,
    )
    return r.rowCount ?? 0
  } finally {
    await owner.end()
  }
}

describe('a dropped DB connection no longer kills the process', () => {
  it('terminating idle pooled connections raises no uncaught error; the next query reconnects', async () => {
    await Promise.all([query('SELECT 1'), query('SELECT 1')]) // park idle clients in the pool
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      expect(await killRuntimeBackends()).toBeGreaterThan(0)
      await sleep(500) // let the 57P01 reach the pool as an 'error' event
      expect(uncaught).toEqual([])
      expect((await query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 })
      expect(pool().listenerCount('error')).toBeGreaterThan(0)
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  it('a query killed mid-flight rejects with a classified connection error (57P01), not a crash', async () => {
    const settled = query('SELECT pg_sleep(10)').then(() => null, (e: unknown) => e)
    await sleep(300)
    await killRuntimeBackends()
    const err = (await settled) as { code?: string } | null
    expect(err?.code).toBe('57P01')
    expect(isConnectionError(err)).toBe(true)
    expect((await query('SELECT 2 AS ok')).rows[0]).toEqual({ ok: 2 })
  })

  it('the daemon loop survives a forced disconnect, heartbeats through a long tick, and records the outage', async () => {
    const hbPath = join(tmpdir(), `bion-hb-${randomUUID()}.json`)
    const pidfile = join(tmpdir(), `bion-pid-${randomUUID()}`)
    const since = new Date(Date.now() - 1000).toISOString()
    let tickNo = 0
    const run = runDaemon({
      intervalMs: 600,
      heartbeatIntervalMs: 200,
      heartbeatPath: hbPath,
      pidfile,
      cluster: false,
      reconcileOnStart: false,
      watchGit: false,
      watchTests: false,
      watchCI: false,
      onTick: async () => {
        tickNo++
        if (tickNo === 2) {
          await killRuntimeBackends() // real server-side disconnect, then surface what the driver reports
          const err = await query('SELECT pg_sleep(0.05)').then(() => null, (e: unknown) => e)
          throw err ?? Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })
        }
        if (tickNo === 4) await sleep(1500) // a long, legitimate tick: the heartbeat must keep moving
      },
    })

    const beats = new Set<string>()
    const t0 = Date.now()
    while (Date.now() - t0 < 12_000 && tickNo < 6) {
      const hb = readHeartbeat(hbPath)
      if (hb) beats.add(hb.ts)
      await sleep(50)
    }
    process.emit('SIGTERM')
    await run

    expect(tickNo).toBeGreaterThanOrEqual(6) // loop kept going past the failed tick
    expect(beats.size).toBeGreaterThan(tickNo) // more beats than ticks => the timer beats on its own
    const ev = await query<{ kind: string }>(
      `SELECT kind FROM events WHERE kind IN ('daemon.db.lost','daemon.db.restored') AND ts > $1 ORDER BY kind`,
      [since],
    )
    expect(ev.rows.map((r) => r.kind)).toEqual(['daemon.db.lost', 'daemon.db.restored'])
  })
})
