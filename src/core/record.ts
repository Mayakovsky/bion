import { query } from '../db/pool.js'
import { newId } from './ids.js'
import type { Decision } from './types.js'

export interface RecordInput {
  id?: string
  decision: string
  rationale?: string
  impact?: string
  movement?: string
  supersedes?: string
}

/**
 * record(snippet) — commit a decision/finding to Bion's ledger (no recipient; a ledger write).
 * Distinct from send() (a routed message). See spec §3.3.
 */
export async function record(input: RecordInput): Promise<Decision> {
  const id = input.id ?? newId('DEC')
  const res = await query<Decision>(
    `INSERT INTO decisions (id, decision, rationale, impact, movement, supersedes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, ts, decision, rationale, impact, movement, supersedes`,
    [
      id,
      input.decision,
      input.rationale ?? '',
      input.impact ?? '',
      input.movement ?? null,
      input.supersedes ?? null,
    ],
  )
  return res.rows[0]!
}
