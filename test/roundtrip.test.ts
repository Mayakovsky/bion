import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import {
  record,
  send,
  queryState,
  routePacket,
  drainOutbox,
  findUnconsumedByHash,
  consume,
  listBox,
  readPacket,
  pool,
  sha256,
} from '../src/index.js'

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

// Gate A extended (directive-146/150, FDQ-B2): the per-project mailbox scoping's own real
// write->register->query round-trip, against the REAL live DB — same gate, real recipient/project
// pair scratch-scoped so it can never touch the real kov/desktop boxes. mailRoot is an isolated
// tmpdir (not the real .bion/mail) so this test writes/reads real files without leaving permanent
// scratch clutter in the live mailbox tree on every run.
describe('mailbox per-project scoping — real DB round-trip (build-and-prove-clean, cutover held per D-150)', () => {
  it('routePacket + drainOutbox + pollStatus-equivalent round-trips a project-scoped packet end to end', async () => {
    const root = join(tmpdir(), `bion-mail-scratch-d150-${randomUUID()}`)
    const recipient = 'scratch-d150-recipient'
    const project = 'scratch-d150-project'
    const token = `zscoped${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const body = `# scoped packet ${token}\nreal round-trip proof`

    // 1. write + register: one real DB transaction (row + outbox entry), then drain materializes
    // the real file — the same production path routePacket()/BaseAdapter.dispatch() use.
    const routed = await routePacket({
      sender: 'kov',
      recipient,
      body,
      origin: 'kov',
      project,
      mailRoot: root,
    })
    expect(routed.deduped).toBe(false)
    await drainOutbox()

    // Real file landed under the NEW per-project shape, not the flat one.
    expect(existsSync(routed.finalPath)).toBe(true)
    expect(routed.finalPath.replace(/\\/g, '/')).toContain(`/${recipient}/${project}/unread/`)
    expect(readFileSync(routed.finalPath, 'utf8')).toBe(body)

    // The DB row itself carries the real project value — independently re-queried, not trusting
    // the object routePacket() already returned in-process.
    const raw = await pool().query<{ project: string | null }>('SELECT project FROM messages WHERE id = $1', [
      routed.message.id,
    ])
    expect(raw.rows[0]?.project).toBe(project)

    // 2. query: listBox() (the dual-shape scan) finds it under the scratch recipient's unread/.
    const found = listBox(recipient, 'unread', root)
    expect(found).toHaveLength(1)
    expect(found[0]!.replace(/\\/g, '/')).toBe(routed.finalPath.replace(/\\/g, '/'))

    // 3. consume: the real routing-authority lookup (content_sha256 + recipient) resolves the row,
    // same call pollStatus() makes — proving the new column doesn't break the existing gate.
    const content = readPacket(found[0]!)
    const row = await findUnconsumedByHash(recipient, sha256(content))
    expect(row?.id).toBe(routed.message.id)
    expect(row?.project).toBe(project)

    const { consumed } = await consume(row!.id, recipient)
    expect(consumed).toBe(true)
  })

  it('a project-scoped write and a flat (unscoped) write for the same scratch recipient both round-trip, independently', async () => {
    const root = join(tmpdir(), `bion-mail-scratch-d150-dual-${randomUUID()}`)
    const recipient = 'scratch-d150-dual-recipient'
    const tokenFlat = `zflat${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const tokenScoped = `zscoped${randomUUID().replace(/-/g, '').slice(0, 10)}`

    const flat = await routePacket({
      sender: 'kov',
      recipient,
      body: `flat packet ${tokenFlat}`,
      origin: 'kov',
      mailRoot: root, // no project — the historical flat shape
    })
    const scoped = await routePacket({
      sender: 'kov',
      recipient,
      body: `scoped packet ${tokenScoped}`,
      origin: 'kov',
      project: 'scratch-d150-project-2',
      mailRoot: root,
    })
    await drainOutbox()

    expect(flat.finalPath.replace(/\\/g, '/')).toContain(`/${recipient}/unread/`)
    expect(scoped.finalPath.replace(/\\/g, '/')).toContain(`/${recipient}/scratch-d150-project-2/unread/`)

    // Both DB rows real and correct: flat carries NULL project, scoped carries its real value.
    const rawFlat = await pool().query<{ project: string | null }>('SELECT project FROM messages WHERE id = $1', [
      flat.message.id,
    ])
    expect(rawFlat.rows[0]?.project).toBeNull()

    // listBox for this recipient returns BOTH, proving an agent's real inbox is the union.
    const found = listBox(recipient, 'unread', root).map((p) => p.replace(/\\/g, '/'))
    expect(found).toHaveLength(2)
    expect(found).toContain(flat.finalPath.replace(/\\/g, '/'))
    expect(found).toContain(scoped.finalPath.replace(/\\/g, '/'))
  })
})
