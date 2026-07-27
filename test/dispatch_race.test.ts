import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KovAdapter, stagePacket, publishStaged, listBox, send } from '../src/index.js'

// FDQ-B8 regression: a packet must never be observable in unread/ before its authoritative row is
// committed. Pre-fix, dispatch() published to unread/ before send() committed, so a poll in that
// window false-quarantined a legit packet.
function freshRoot(): string {
  return join(tmpdir(), `bion-mail-${randomUUID()}`)
}

describe('FDQ-B8 — dispatch ordering race', () => {
  it('a packet becomes visible in unread/ only after its row exists; in-window poll quarantines nothing', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const body = `race ${randomUUID()}`

    // Stage the payload — written to disk but NOT visible in unread/.
    const staged = stagePacket('kov', body, { root })
    expect(listBox('kov', 'unread', root)).toEqual([])

    // Commit the authoritative row pointing at the eventual path (this is the send() step).
    await send({ sender: 'desktop', recipient: 'kov', body, bodyPath: staged.finalPath, origin: 'desktop' })

    // THE RACE WINDOW: row exists, packet still staged. A poll here must find nothing to quarantine.
    const inWindow = await kov.pollStatus()
    expect(inWindow.consumed).toHaveLength(0)
    expect(inWindow.flagged).toHaveLength(0)
    expect(listBox('kov', 'unread', root)).toEqual([])

    // Publish (the visible point). Now the packet consumes cleanly — never false-quarantined.
    publishStaged(staged)
    const afterPublish = await kov.pollStatus()
    expect(afterPublish.consumed).toHaveLength(1)
    expect(afterPublish.flagged).toHaveLength(0)
    expect(afterPublish.consumed[0]!.content).toBe(body)
  })

  it('polls interleaved with concurrent dispatches never false-quarantine a legit packet', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const N = 20
    const bodies = Array.from({ length: N }, (_, i) => `c-${i}-${randomUUID()}`)

    // Fire all dispatches concurrently; interleave serial polls while they run.
    const dispatches = bodies.map((body) =>
      kov.dispatch({ sender: 'desktop', recipient: 'kov', body, origin: 'desktop' }),
    )

    let flagged = 0
    const consumed = new Set<string>()
    for (let k = 0; k < N + 5; k++) {
      const pr = await kov.pollStatus()
      flagged += pr.flagged.length
      pr.consumed.forEach((c) => consumed.add(c.message.id))
    }
    await Promise.all(dispatches)
    const drain = await kov.pollStatus()
    flagged += drain.flagged.length
    drain.consumed.forEach((c) => consumed.add(c.message.id))

    expect(flagged).toBe(0) // no legit packet ever quarantined
    expect(consumed.size).toBe(N) // each delivered exactly once
  })
})
