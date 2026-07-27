import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KovAdapter, writePacket, query, sha256 } from '../src/index.js'

// Gate B: a forged/unmatched packet is refused (spec §5, inv 12). The DB is routing authority;
// a file with no matching UNCONSUMED row cannot dispatch the agent.
describe('DB-as-routing-authority refuses unmatched/forged packets', () => {
  it('a packet with no matching DB row is flagged, not consumed', async () => {
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const kov = new KovAdapter({ mailRoot: root })

    const forged = `forged ${randomUUID()} — never registered in Bion`
    writePacket('kov', forged, { root }) // drop straight into unread/, no dispatch()

    const poll = await kov.pollStatus()
    expect(poll.consumed).toHaveLength(0)
    expect(poll.flagged).toHaveLength(1)
    expect(poll.flagged[0]!.content_sha256).toBe(sha256(forged))
    expect(poll.flagged[0]!.path.replace(/\\/g, '/')).toContain('/kov/flagged/')

    // it was flagged via an events row (idempotent by sha)
    const ev = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM events WHERE kind = 'packet.unmatched' AND dedup_key = $1`,
      [`unmatched:kov:${sha256(forged)}`],
    )
    expect(ev.rows[0]!.n).toBe('1')
  })

  it('a tampered packet (body mutated after dispatch) fails content_sha256 corroboration', async () => {
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const kov = new KovAdapter({ mailRoot: root })

    const disp = await kov.dispatch({
      sender: 'desktop',
      recipient: 'kov',
      body: `legit ${randomUUID()}`,
      origin: 'desktop',
    })
    // Attacker rewrites the on-disk packet after it was registered.
    writeFileSync(disp.path, `TAMPERED ${randomUUID()}`, 'utf8')

    const poll = await kov.pollStatus()
    expect(poll.consumed).toHaveLength(0) // hash no longer matches the row
    expect(poll.flagged).toHaveLength(1)

    // the genuine row remains UNCONSUMED (tamper cannot consume it)
    const row = await query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM messages m
       WHERE m.id = $1 AND NOT EXISTS (SELECT 1 FROM message_consumptions c WHERE c.message_id = m.id)`,
      [disp.message.id],
    )
    expect(row.rows[0]!.n).toBe('1')
  })
})
