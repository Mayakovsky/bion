import pg from 'pg'
import { env } from '../env.js'

const { Pool } = pg

/**
 * Anything that can run a query — the Pool or a checked-out client mid-transaction. Core
 * functions accept an optional Executor so a caller can run them inside one transaction
 * (e.g. write a state row + its outbox entry atomically); default is the pool (autocommit).
 */
export interface Executor {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>
}

// Lazily-constructed runtime pool (bion_rw). closePool() nulls the ref so a later
// call transparently reopens — this lets test files each close cleanly without
// starving the next file (see test/setup.ts).
let poolRef: pg.Pool | null = null

export function pool(): pg.Pool {
  if (!poolRef) {
    poolRef = new Pool({ connectionString: env.databaseUrl, max: 5 })
  }
  return poolRef
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<R>> {
  return pool().query<R>(text, params as never[])
}

/** Run fn inside a single transaction on one checked-out client. */
export async function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function closePool(): Promise<void> {
  if (poolRef) {
    await poolRef.end()
    poolRef = null
  }
}
