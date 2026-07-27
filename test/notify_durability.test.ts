import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  withTransaction,
  enqueueOutbox,
  drainOutbox,
  reconcile,
  notifyDurably,
  query,
  type NotifyInput,
} from '../src/index.js'

// Directive-04: notify must be AT-LEAST-ONCE (dup-tolerant), not at-most-once. A crash between the
// claim and the send completing must NOT lose the notification.
const capture = () => {
  const calls: NotifyInput[] = []
  return { calls, notify: async (i: NotifyInput) => (calls.push(i), { sent: true, dryRun: false, status: 200 }) }
}

async function enqueueNotify(key: string, message: string): Promise<void> {
  await withTransaction((c) => enqueueOutbox({ kind: 'notify', dedupKey: key, payload: { title: 't', message, priority: 3, tags: [] }, }, c))
}
const statusOf = async (key: string) =>
  (await query<{ status: string }>(`SELECT status FROM outbox WHERE dedup_key = $1`, [key])).rows[0]!.status

describe('notify durability (at-least-once)', () => {
  it('re-sends a notification orphaned in "sending" (crash after claim / before send)', async () => {
    const key = `notify:test:${randomUUID()}`
    const msg = `m-${randomUUID()}`
    await enqueueNotify(key, msg)

    // Simulate a crash AFTER the claim commit but BEFORE the ntfy send: the row is stuck 'sending'.
    await query(`UPDATE outbox SET status = 'sending' WHERE dedup_key = $1`, [key])

    const { calls, notify } = capture()
    await reconcile({ notify })
    expect(calls.filter((c) => c.message === msg)).toHaveLength(1) // re-sent, not lost
    expect(await statusOf(key)).toBe('done')

    // A second reconcile does not re-send a done entry.
    await reconcile({ notify })
    expect(calls.filter((c) => c.message === msg)).toHaveLength(1)
  })

  it('the normal path sends exactly once (no gratuitous duplicates)', async () => {
    const key = `notify:test:${randomUUID()}`
    const msg = `m-${randomUUID()}`
    await enqueueNotify(key, msg)

    const { calls, notify } = capture()
    await drainOutbox({ notify })
    expect(calls.filter((c) => c.message === msg)).toHaveLength(1)
    expect(await statusOf(key)).toBe('done')

    await drainOutbox({ notify })
    expect(calls.filter((c) => c.message === msg)).toHaveLength(1)
  })

  it('notifyDurably sends once and is idempotent on its dedup key', async () => {
    const key = `notify:dur:${randomUUID()}`
    const msg = `m-${randomUUID()}`
    const { calls, notify } = capture()

    const r1 = await notifyDurably({ title: 't', message: msg, priority: 3, tags: [] }, key, { notify })
    expect(r1?.sent).toBe(true)
    expect(calls.filter((c) => c.message === msg)).toHaveLength(1)

    // same key again → enqueue is a no-op (already done) → no re-send
    await notifyDurably({ title: 't', message: msg, priority: 3, tags: [] }, key, { notify })
    expect(calls.filter((c) => c.message === msg)).toHaveLength(1)
  })
})
