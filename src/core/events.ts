import { pool, type Executor } from '../db/pool.js'
import { dedupKey, sha256 } from './ids.js'
import type { BionEvent, CostSeat } from './types.js'

export interface EventInput {
  kind: string
  source: string
  payload?: Record<string, unknown>
  /** Explicit dedup key; defaults to a stable hash of kind + source + payload. */
  dedupKey?: string
  /** Cost attribution (directive-18) — omit on non-cost events. */
  targetSeat?: CostSeat
  triggerClass?: string
  model?: string
  tokensIn?: number
  tokensOut?: number
  estCost?: number
  isApproximate?: boolean
}

export interface EventResult {
  event: BionEvent
  /** true when the dedup_key already existed — duplicate signal was a no-op (inv 11). */
  deduped: boolean
}

/**
 * Append an event. Idempotent on dedup_key: duplicate completion/watcher signals collapse
 * to a single row (spec §10 risk mitigation).
 */
const EVENT_COLUMNS = `id, ts, kind, payload, source, dedup_key,
   target_seat, trigger_class, model, tokens_in, tokens_out, est_cost::float8 AS est_cost, is_approximate`

export async function recordEvent(input: EventInput, exec: Executor = pool()): Promise<EventResult> {
  const payload = input.payload ?? {}
  const key = input.dedupKey ?? dedupKey(input.kind, input.source, sha256(JSON.stringify(payload)))

  const inserted = await exec.query<BionEvent>(
    `INSERT INTO events (kind, payload, source, dedup_key,
       target_seat, trigger_class, model, tokens_in, tokens_out, est_cost, is_approximate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING ${EVENT_COLUMNS}`,
    [
      input.kind,
      payload,
      input.source,
      key,
      input.targetSeat ?? null,
      input.triggerClass ?? null,
      input.model ?? null,
      input.tokensIn ?? null,
      input.tokensOut ?? null,
      input.estCost ?? null,
      input.isApproximate ?? null,
    ],
  )

  if ((inserted.rowCount ?? 0) > 0) {
    return { event: inserted.rows[0]!, deduped: false }
  }

  const existing = await exec.query<BionEvent>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE dedup_key = $1`,
    [key],
  )
  return { event: existing.rows[0]!, deduped: true }
}
