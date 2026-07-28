import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { checkUsage, type NotifyInput, type UsageSnapshot } from '../src/index.js'

const capture = () => {
  const calls: NotifyInput[] = []
  return { calls, notify: async (i: NotifyInput) => (calls.push(i), { sent: true, dryRun: false, status: 200 }) }
}

describe('usage tracking + threshold warning (E3)', () => {
  it('warns once per reset window at/above threshold, and not below', async () => {
    const resetAt = `W-${randomUUID()}`
    const source = (): UsageSnapshot => ({ used: 80, limit: 100, resetAt })
    const { calls, notify } = capture()
    const mine = () => calls.filter((c) => c.message.includes(resetAt)).length

    const r1 = await checkUsage({ source, notify, threshold: 0.8 })
    expect(r1.pct).toBeCloseTo(0.8)
    expect(r1.warned).toBe(true)
    expect(mine()).toBe(1)

    // same window → deduped, no second warning
    const r2 = await checkUsage({ source, notify, threshold: 0.8 })
    expect(r2.warned).toBe(false)
    expect(mine()).toBe(1)

    // below threshold in a different window → no warning
    const r3 = await checkUsage({ source: () => ({ used: 50, limit: 100, resetAt: `W2-${randomUUID()}` }), notify, threshold: 0.8 })
    expect(r3.warned).toBe(false)
  })

  it('no snapshot / no limit → no warning', async () => {
    expect((await checkUsage({ source: () => null })).warned).toBe(false)
    expect((await checkUsage({ source: () => ({ used: 5, limit: 0, resetAt: 'x' }) })).warned).toBe(false)
  })
})
