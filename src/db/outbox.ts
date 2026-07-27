import { existsSync } from 'node:fs'
import { pool, query, withTransaction, type Executor } from './pool.js'
import { isConsumed } from '../core/consumption.js'
import { publishBodyToPath } from '../mailbox/mailbox.js'
import { notifyForces, type NotifyFn, type NotifyInput, type NotifyResult } from '../notify/ntfy.js'

// Transactional outbox (Phase D1). Callers write a state row AND an outbox entry in ONE
// transaction (enqueueOutbox on the tx client); a drainer/reconciler performs the side effect and
// marks the entry done. Every committed intent survives a crash at any point, with these guarantees:
//   - publish : EXACTLY-ONCE  (idempotent place + status-independent repairPublishes)
//   - notify  : AT-LEAST-ONCE (claim→'sending', send, then 'done'; a crash mid-send re-sends on
//               reconcile — a duplicate ntfy to a human is harmless, a lost one is not; directive-04)

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
  status: 'pending' | 'sending' | 'done'
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

/** Claim a pending publish entry straight to 'done' (publish is idempotent + repair-covered). */
async function claimDone(id: string, exec: Executor = pool()): Promise<boolean> {
  const res = await exec.query(
    `UPDATE outbox SET status = 'done', attempts = attempts + 1, done_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id],
  )
  return (res.rowCount ?? 0) > 0
}

/** Claim a pending notify entry to the pre-send 'sending' state (marked 'done' only after send). */
async function claimSending(id: string, exec: Executor = pool()): Promise<boolean> {
  const res = await exec.query(
    `UPDATE outbox SET status = 'sending', attempts = attempts + 1, done_at = NULL
     WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id],
  )
  return (res.rowCount ?? 0) > 0
}

async function markDone(id: string, exec: Executor = pool()): Promise<void> {
  await exec.query(`UPDATE outbox SET status = 'done', done_at = now() WHERE id = $1`, [id])
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
 * Drain pending entries. publish is claimed straight to 'done' then materialized (idempotent). notify
 * is claimed to 'sending', SENT, then marked 'done' — so a crash between the send and the mark leaves
 * the row 'sending' for the reconciler to re-send (at-least-once). A failure reverts to 'pending'.
 */
export async function drainOutbox(deps: DrainDeps = {}): Promise<DrainResult> {
  const notify = deps.notify ?? ((i: NotifyInput) => notifyForces(i))
  const pending = await query<OutboxRow>(
    `SELECT id, kind, payload, status, dedup_key, attempts FROM outbox WHERE status = 'pending' ORDER BY created`,
  )
  const out: DrainResult = { published: 0, notifications: [] }

  for (const e of pending.rows) {
    if (e.kind === 'publish') {
      if (!(await claimDone(e.id))) continue
      try {
        await ensurePublished(e.payload as PublishPayload)
        out.published++
      } catch (err) {
        await markPending(e.id)
        throw err
      }
    } else {
      if (!(await claimSending(e.id))) continue
      try {
        const result = await notify(e.payload as NotifyPayload)
        await markDone(e.id) // mark done ONLY after the send completes
        out.notifications.push({ dedupKey: e.dedup_key, result })
      } catch (err) {
        await markPending(e.id) // send failed → retry next drain
        throw err
      }
    }
  }
  return out
}

/**
 * Recover notify entries stuck in 'sending' (a crash occurred between claim and mark-done). Re-send
 * and mark done. This is the notify half of at-least-once; a duplicate send here is acceptable.
 */
async function recoverSendingNotifies(deps: DrainDeps = {}): Promise<DrainResult['notifications']> {
  const notify = deps.notify ?? ((i: NotifyInput) => notifyForces(i))
  const stuck = await query<OutboxRow>(
    `SELECT id, kind, payload, status, dedup_key, attempts FROM outbox WHERE kind = 'notify' AND status = 'sending' ORDER BY created`,
  )
  const out: DrainResult['notifications'] = []
  for (const e of stuck.rows) {
    const result = await notify(e.payload as NotifyPayload)
    await markDone(e.id)
    out.push({ dedupKey: e.dedup_key, result })
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

/**
 * Startup + periodic reconciliation: repair missing publishes, re-send notify entries orphaned in
 * 'sending' (at-least-once), then drain pending intents.
 */
export async function reconcile(deps: DrainDeps = {}): Promise<DrainResult & { repaired: number }> {
  const repaired = await repairPublishes()
  const recovered = await recoverSendingNotifies(deps)
  const drained = await drainOutbox(deps)
  return { published: drained.published, notifications: [...recovered, ...drained.notifications], repaired }
}

/**
 * Durably send a notification: persist a notify-intent to the outbox (idempotent on dedupKey), then
 * drain. If the process dies before the send, the reconciler re-sends it (at-least-once). Used to
 * give reactive/watcher notifications the same durability as completion notifications (FDQ-B10).
 */
export async function notifyDurably(
  payload: NotifyPayload,
  dedupKey: string,
  deps: DrainDeps = {},
): Promise<NotifyResult | undefined> {
  await withTransaction((client) => enqueueOutbox({ kind: 'notify', payload, dedupKey }, client))
  const drain = await drainOutbox({ notify: deps.notify })
  return drain.notifications.find((n) => n.dedupKey === dedupKey)?.result
}
