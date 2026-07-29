import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordDesktopCost, recordDesktopCostSafely, CHARS_PER_TOKEN, routePacket, query } from '../src/index.js'

const freshRoot = () => join(tmpdir(), `bion-mail-${randomUUID()}`)

describe('desktop cost collector — char-size estimate, always approximate, never blocking', () => {
  it('sizes tokens_out when desktop is the sender, tokens_in when desktop is the recipient', async () => {
    const bodyOut = 'x'.repeat(400)
    const outResult = await recordDesktopCost({
      body: bodyOut,
      sender: 'desktop',
      recipient: 'kov',
      triggerClass: 'directive',
      messageId: `msg-${randomUUID()}`,
    })
    expect(outResult!.event.tokens_out).toBe(Math.ceil(400 / CHARS_PER_TOKEN))
    expect(outResult!.event.tokens_in).toBe(0)
    expect(outResult!.event.is_approximate).toBe(true)
    expect(outResult!.event.target_seat).toBe('desktop')

    const bodyIn = 'y'.repeat(37)
    const inResult = await recordDesktopCost({
      body: bodyIn,
      sender: 'kov',
      recipient: 'desktop',
      triggerClass: 'status',
      messageId: `msg-${randomUUID()}`,
    })
    expect(inResult!.event.tokens_in).toBe(Math.ceil(37 / CHARS_PER_TOKEN))
    expect(inResult!.event.tokens_out).toBe(0)
  })

  it('is a no-op when neither party is desktop', async () => {
    const result = await recordDesktopCost({
      body: 'hi',
      sender: 'kov',
      recipient: 'kov',
      triggerClass: 'x',
      messageId: `msg-${randomUUID()}`,
    })
    expect(result).toBeNull()
  })

  it('dedups on messageId — a replay does not double-record', async () => {
    const messageId = `msg-${randomUUID()}`
    const first = await recordDesktopCost({ body: 'abcd', sender: 'desktop', recipient: 'kov', triggerClass: 'directive', messageId })
    const second = await recordDesktopCost({
      body: 'abcd-a-very-different-length-this-time',
      sender: 'desktop',
      recipient: 'kov',
      triggerClass: 'directive',
      messageId,
    })
    expect(first!.deduped).toBe(false)
    expect(second!.deduped).toBe(true)
    expect(second!.event.id).toBe(first!.event.id)
  })

  it('recordDesktopCostSafely swallows a failing estimate instead of throwing (never blocks a dispatch)', async () => {
    const throwingExec = { query: async () => { throw new Error('boom') } }
    await expect(
      recordDesktopCostSafely(
        { body: 'x', sender: 'desktop', recipient: 'kov', triggerClass: 'directive', messageId: `msg-${randomUUID()}` },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        throwingExec as any,
      ),
    ).resolves.toBeUndefined()
  })

  it('routePacket wires the collector: a dispatch TO desktop records tokens_in sized off the full body', async () => {
    const root = freshRoot()
    const body = 'z'.repeat(123)
    const routed = await routePacket({ sender: 'bion', recipient: 'desktop', body, origin: 'bion', type: 'status', mailRoot: root })

    const rows = await query<{ tokens_in: number; target_seat: string; trigger_class: string; is_approximate: boolean }>(
      `SELECT tokens_in, target_seat, trigger_class, is_approximate FROM events WHERE dedup_key = $1`,
      [`cost.desktop:${routed.message.id}`],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.tokens_in).toBe(Math.ceil(123 / CHARS_PER_TOKEN))
    expect(rows.rows[0]!.target_seat).toBe('desktop')
    expect(rows.rows[0]!.trigger_class).toBe('status')
    expect(rows.rows[0]!.is_approximate).toBe(true)
  })

  it('routePacket records nothing when neither party is desktop', async () => {
    const root = freshRoot()
    const routed = await routePacket({ sender: 'bion', recipient: 'kov', body: 'hello', origin: 'bion', mailRoot: root })
    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE dedup_key = $1`, [
      `cost.desktop:${routed.message.id}`,
    ])
    expect(rows.rows[0]!.n).toBe('0')
  })
})
