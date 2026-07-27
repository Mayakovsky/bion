import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { record, send, queryState } from '../src/index.js'

// Gate A: write -> register -> query round-trips.
describe('write→register→query round-trip', () => {
  it('record() a decision is retrievable via FTS', async () => {
    const token = `zdec${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const dec = await record({
      decision: `decision ${token} to enforce append-only ledgers`,
      rationale: 'gate A round-trip',
      movement: 'bion',
    })
    const { hits } = await queryState(token, { grepDisk: false })
    const found = hits.find((h) => h.kind === 'decision' && h.id === dec.id)
    expect(found, 'decision should surface in query_state').toBeTruthy()
  })

  it('send() a message registers a row retrievable via FTS', async () => {
    const token = `zmsg${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const { message, deduped } = await send({
      sender: 'desktop',
      recipient: 'kov',
      summary: `handoff ${token} packet`,
      body: `# packet ${token}\nbody`,
      origin: 'desktop',
    })
    expect(deduped).toBe(false)
    expect(message.content_sha256).toMatch(/^[0-9a-f]{64}$/)

    const { hits } = await queryState(token, { grepDisk: false })
    const found = hits.find((h) => h.kind === 'message' && h.id === message.id)
    expect(found, 'message should surface in query_state').toBeTruthy()
  })
})
