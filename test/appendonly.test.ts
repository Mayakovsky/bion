import { describe, it, expect } from 'vitest'
import { send, recordEvent, query } from '../src/index.js'

// Gate A: UPDATE/DELETE on messages/events are rejected for the runtime role (inv 5).
// The runtime pool connects as bion_rw, which lacks UPDATE/DELETE on these tables.
const INSUFFICIENT_PRIVILEGE = '42501'

describe('append-only enforcement (bion_rw cannot mutate messages/events)', () => {
  it('UPDATE messages is rejected', async () => {
    const { message } = await send({
      sender: 'desktop',
      recipient: 'kov',
      summary: 'immutable',
      body: 'x',
      origin: 'desktop',
    })
    await expect(
      query('UPDATE messages SET summary = $2 WHERE id = $1', [message.id, 'tampered']),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
  })

  it('DELETE messages is rejected', async () => {
    const { message } = await send({
      sender: 'desktop',
      recipient: 'kov',
      summary: 'immutable',
      body: 'y',
      origin: 'desktop',
    })
    await expect(
      query('DELETE FROM messages WHERE id = $1', [message.id]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
  })

  it('UPDATE events is rejected', async () => {
    const { event } = await recordEvent({ kind: 'gate.check', source: 'test' })
    await expect(
      query('UPDATE events SET kind = $2 WHERE id = $1', [event.id, 'tampered']),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
  })

  it('DELETE events is rejected', async () => {
    const { event } = await recordEvent({ kind: 'gate.check2', source: 'test' })
    await expect(
      query('DELETE FROM events WHERE id = $1', [event.id]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
  })
})
