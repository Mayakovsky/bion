import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KovAdapter, handoff } from '../src/index.js'

// Gate B: one Desktop -> Kov handoff round-trips through Bion with ZERO copy-paste.
describe('Desktop → Kov handoff through Bion', () => {
  it('flows a handoff packet disk+DB with no manual relay, consumed exactly once', async () => {
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const kov = new KovAdapter({ mailRoot: root })

    // Desktop produces a handoff summary from live Bion state; make it unique per run.
    const hp = await handoff('kov')
    const body = `${hp.markdown}\n<!-- run ${randomUUID()} -->\n`

    // Bion routes Desktop's packet to Kov's mailbox + registers it (routing authority).
    const disp = await kov.dispatch({
      sender: 'desktop',
      recipient: 'kov',
      summary: 'phase handoff',
      body,
      origin: 'desktop',
    })
    expect(disp.deduped).toBe(false)
    expect(disp.path.replace(/\\/g, '/')).toContain('/kov/unread/')

    // Kov wakes and reads its inbox — the packet arrives with byte-identical content.
    const poll = await kov.pollStatus()
    expect(poll.flagged).toHaveLength(0)
    expect(poll.consumed).toHaveLength(1)
    expect(poll.consumed[0]!.content).toBe(body) // zero copy-paste: same bytes end to end
    expect(poll.consumed[0]!.message.id).toBe(disp.message.id)
    expect(poll.consumed[0]!.message.content_sha256).toBe(disp.message.content_sha256)
    expect(poll.consumed[0]!.path.replace(/\\/g, '/')).toContain('/kov/read/')

    // Consuming is idempotent: a second wake sees nothing (no re-dispatch).
    const again = await kov.pollStatus()
    expect(again.consumed).toHaveLength(0)
    expect(again.flagged).toHaveLength(0)
  })
})
