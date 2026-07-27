import { query } from '../db/pool.js'
import type { Agent, Fdq, Invariant } from './types.js'

export async function listInvariants(activeOnly = true): Promise<Invariant[]> {
  const res = await query<Invariant>(
    `SELECT id, statement, movement, active FROM invariants
     ${activeOnly ? 'WHERE active = true' : ''} ORDER BY id`,
  )
  return res.rows
}

export async function listFdqs(status?: 'open' | 'resolved'): Promise<Fdq[]> {
  const res = await query<Fdq>(
    `SELECT id, movement, question, ruling, status, opened, resolved FROM fdqs
     ${status ? 'WHERE status = $1' : ''} ORDER BY id`,
    status ? [status] : undefined,
  )
  return res.rows
}

export async function getAgent(id: string): Promise<Agent | null> {
  const res = await query<Agent>(
    `SELECT id, type, capabilities, wake_mode, authority FROM agents WHERE id = $1`,
    [id],
  )
  return res.rows[0] ?? null
}
