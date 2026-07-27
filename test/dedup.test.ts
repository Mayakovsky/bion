import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { send, recordEvent, query } from '../src/index.js'

// Gate A: a dedup_key replay is a no-op (inv 11).
describe('idempotency / dedup_key replay is a no-op', () => {
  it('re-sending the same dedup_key does not insert a second message', async () => {
    const key = `k-msg-${randomUUID()}`
    const first = await send({
      sender: 'desktop',
      recipient: 'kov',
      summary: 'dedup message',
      body: 'body-A',
      origin: 'desktop',
      dedupKey: key,
    })
    const second = await send({
      sender: 'desktop',
      recipient: 'kov',
      summary: 'dedup message (replay, different body)',
      body: 'body-B-different',
      origin: 'desktop',
      dedupKey: key,
    })

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.message.id).toBe(first.message.id)
    // replay must NOT overwrite the original body hash
    expect(second.message.content_sha256).toBe(first.message.content_sha256)

    const count = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM messages WHERE dedup_key = $1',
      [key],
    )
    expect(count.rows[0]!.n).toBe('1')
  })

  it('re-recording the same event dedup_key is a no-op', async () => {
    const key = `k-evt-${randomUUID()}`
    const first = await recordEvent({ kind: 'task.completed', source: 'kov', dedupKey: key })
    const second = await recordEvent({ kind: 'task.completed', source: 'kov', dedupKey: key })

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.event.id).toBe(first.event.id)

    const count = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM events WHERE dedup_key = $1',
      [key],
    )
    expect(count.rows[0]!.n).toBe('1')
  })
})
