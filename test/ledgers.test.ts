import { describe, it, expect } from 'vitest'
import { listInvariants, listFdqs, queryState, getAgent } from '../src/index.js'

// Gate A: FDQ + invariant ledgers are seeded and queryable.
describe('seeded ledgers are queryable', () => {
  it('all 14 invariants are seeded and active', async () => {
    const inv = await listInvariants()
    expect(inv.length).toBeGreaterThanOrEqual(14)
    const inv5 = inv.find((i) => i.id === 'INV-5')
    expect(inv5?.statement).toMatch(/append-only/i)
    expect(inv.every((i) => i.active)).toBe(true)
  })

  it('FDQ ledger is seeded with FDQ-B3 resolved and others open', async () => {
    const all = await listFdqs()
    const ids = all.map((f) => f.id)
    expect(ids).toEqual(expect.arrayContaining(['FDQ-B1', 'FDQ-B2', 'FDQ-B3', 'FDQ-B4', 'FDQ-B5']))
    const b3 = all.find((f) => f.id === 'FDQ-B3')!
    expect(b3.status).toBe('resolved')
    expect(b3.ruling).toBeTruthy()
    expect(all.find((f) => f.id === 'FDQ-B1')!.status).toBe('open')
  })

  it('invariant ledger is FTS-queryable', async () => {
    const { hits } = await queryState('append-only', { grepDisk: false })
    expect(hits.some((h) => h.kind === 'invariant')).toBe(true)
  })

  it('FDQ ledger is FTS-queryable', async () => {
    const { hits } = await queryState('relocation', { grepDisk: false })
    expect(hits.some((h) => h.kind === 'fdq' && h.id === 'FDQ-B1')).toBe(true)
  })

  it('agent envelopes are seeded (read-only surface)', async () => {
    const kov = await getAgent('kov')
    expect(kov?.wake_mode).toBe('auto')
    const desktop = await getAgent('desktop')
    expect(desktop?.wake_mode).toBe('user_initiated')
  })
})
