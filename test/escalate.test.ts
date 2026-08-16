import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routePacket, pointer, serialize, type NotifyInput } from '../src/index.js'

function freshRoot(): string {
  return join(tmpdir(), `bion-mail-escalate-${randomUUID()}`)
}

function capture() {
  const calls: NotifyInput[] = []
  return { calls, notify: async (i: NotifyInput) => (calls.push(i), { sent: true, dryRun: false, status: 200 }) }
}

describe('escalate intent -> notifyDurably (directive-71 Task 2)', () => {
  it('a routePacket() call with an escalate-intent body triggers exactly one notifyDurably call, deduped on the message id', async () => {
    const root = freshRoot()
    const { calls, notify } = capture()
    const body = serialize(
      pointer('escalate', { fields: { topic: 'escalate-test' }, note: 'verifying notify wiring, no real gate crossed' }),
    )

    const routed = await routePacket({
      sender: 'kov',
      recipient: 'desktop',
      body,
      origin: 'kov',
      thread: `t-escalate-${randomUUID()}`,
      mailRoot: root,
      notify,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.title).toContain('ESCALATE')
    expect(calls[0]!.message).toContain('escalate-test')
    expect(calls[0]!.priority).toBe(5)
    expect(calls[0]!.tags).toEqual(expect.arrayContaining(['bion', 'escalate']))
    expect(routed.deduped).toBe(false)
  })

  it('a non-escalate dispatch triggers no notifyDurably call', async () => {
    const root = freshRoot()
    const { calls, notify } = capture()
    const body = serialize(pointer('status', { fields: { topic: 'not-an-escalation' } }))

    await routePacket({
      sender: 'kov',
      recipient: 'desktop',
      body,
      origin: 'kov',
      thread: `t-status-${randomUUID()}`,
      mailRoot: root,
      notify,
    })

    expect(calls).toHaveLength(0)
  })

  it('a second routePacket() of the identical escalate packet (retry/reconcile) does not double-notify', async () => {
    const root = freshRoot()
    const { calls, notify } = capture()
    const thread = `t-retry-${randomUUID()}`
    const body = serialize(pointer('escalate', { fields: { topic: 'retry-check' }, note: 'idempotency check' }))

    const first = await routePacket({ sender: 'kov', recipient: 'desktop', body, origin: 'kov', thread, mailRoot: root, notify })
    const second = await routePacket({ sender: 'kov', recipient: 'desktop', body, origin: 'kov', thread, mailRoot: root, notify })

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true) // identical dedup_key (sender+recipient+thread+content) -> no-op row
    expect(second.message.id).toBe(first.message.id)
    expect(calls).toHaveLength(1) // notifyDurably's own dedup key (message id) held across the retry
  })
})
