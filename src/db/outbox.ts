import { existsSync } from 'node:fs'
import { pool, query, type Executor } from './pool.js'
import { isConsumed } from '../core/consumption.js'
import { publishBodyToPath } from '../mailbox/mailbox.js'
import { notifyForces, type NotifyFn, type NotifyInput, type NotifyResult } from '../notify/ntfy.js'

// Transactional outbox (Phase D1). Callers write a state row AND an outbox entry in ONE
// transaction (enqueueOutbox on the tx client); a drainer/reconciler performs the side effect
// and marks the entry done — idempotently. Guarantees every committed intent is eventually
// performed exactly once, surviving a crash at any point.

export type OutboxKind = 'publish' | 'notify'

export interface PublishPayload {
  messageId: string
  finalPath: string
  body: string
}
export type NotifyPayload = NotifyInput

export interface OutboxRow {
  id: string
  kind: OutboxKind
  payload: PublishPayload | NotifyPayload
  status: 'pending' | 'done'
  dedup_key: string
  attempts: number
}

export interface EnqueueInput {
  kind: OutboxKind
  payload: PublishPayload | NotifyPayload
  dedupKey: string
}

/** Enqueue an outbox entry. MUST run on the same tx client as the state row it accompanies. */
export async function enqueueOutbox(input: EnqueueInput, exec: Executor): Promise<void> {
  await exec.query(
    `INSERT INTO outbox (kind, payload, dedup_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [input.kind, JSON.stringify(input.payload), input.dedupKey],
  )
}

export interface DrainDeps {
  notify?: NotifyFn
}
export interface DrainResult {
  published: number
  notifications: { dedupKey: string; result: NotifyResult }[]
}

/** Atomically claim a pending entry (pending → done). Returns true if this caller won the claim. */
async function claim(id: string, exec: Executor = pool()): Promise<boolean> {
  const res = await exec.query(
    `UPDATE outbox SET status = 'done', attempts = attempts + 1, done_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id],
  )
  return (res.rowCount ?? 0) > 0
}

/** Revert a claimed entry so it is retried on the next drain (side effect failed). */
async function markPending(id: string, exec: Executor = pool()): Promise<void> {
  await exec.query(`UPDATE outbox SET status = 'pending', done_at = NULL WHERE id = $1`, [id])
}

/** Idempotently ensure a publish entry's packet is materialized on disk. */
async function ensurePublished(payload: PublishPayload): Promise<'published' | 'present' | 'consumed'> {
  if (await isConsumed(payload.messageId)) return 'consumed' // already delivered + consumed
  if (existsSync(payload.finalPath)) return 'present' // already in unread/
  publishBodyToPath(payload.finalPath, payload.body)
  return 'published'
}

/**
 * Drain pending entries. Each entry is claimed (so a concurrent drainer / re-run cannot double-act),
 * then its side effect is performed; a failure reverts the claim for retry. publish is idempotent
 * (existsSync/consumed guard); notify is claim-then-send so a re-drain never double-notifies.
 */
export async function drainOutbox(deps: DrainDeps = {}): Promise<DrainResult> {
  const notify = deps.notify ?? ((i: NotifyInput) => notifyForces(i))
  const pending = await query<OutboxRow>(
    `SELECT id, kind, payload, status, dedup_key, attempts FROM outbox WHERE status = 'pending' ORDER BY created`,
  )
  const out: DrainResult = { published: 0, notifications: [] }

  for (const e of pending.rows) {
    if (!(await claim(e.id))) continue // someone else took it
    try {
      if (e.kind === 'publish') {
        await ensurePublished(e.payload as PublishPayload)
        out.published++
      } else {
        const result = await notify(e.payload as NotifyPayload)
        out.notifications.push({ dedupKey: e.dedup_key, result })
      }
    } catch (err) {
      await markPending(e.id) // roll the claim back; retry next drain
      throw err
    }
  }
  return out
}

/**
 * Repair the rename-window: re-publish any publish entry whose file never reached a box and whose
 * message is not yet consumed — from the persisted payload (the body is durable, never lost).
 * Covers a crash after claim-but-before-publish, independent of outbox status.
 */
export async function repairPublishes(): Promise<number> {
  const rows = await query<OutboxRow>(`SELECT id, kind, payload, status, dedup_key, attempts FROM outbox WHERE kind = 'publish'`)
  let repaired = 0
  for (const e of rows.rows) {
    const p = e.payload as PublishPayload
    if (!(await isConsumed(p.messageId)) && !existsSync(p.finalPath)) {
      publishBodyToPath(p.finalPath, p.body)
      repaired++
    }
  }
  return repaired
}

/** Startup + periodic reconciliation: repair missing publishes, then drain pending intents. */
export async function reconcile(deps: DrainDeps = {}): Promise<DrainResult & { repaired: number }> {
  const repaired = await repairPublishes()
  const drained = await drainOutbox(deps)
  return { ...drained, repaired }
}
