import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { query, collectCost, formatCost, type CostScale } from '../src/index.js'

async function insertCostEvent(opts: {
  seat: 'kov' | 'desktop'
  trigger: string
  model: string
  tokensIn: number
  tokensOut: number
  estCost: number | null
  approx: boolean
  ts: Date
  sessionId?: string
}): Promise<void> {
  await query(
    `INSERT INTO events (ts, kind, payload, source, dedup_key, target_seat, trigger_class, model, tokens_in, tokens_out, est_cost, is_approximate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      opts.ts,
      `cost.${opts.seat}`,
      opts.sessionId ? { sessionId: opts.sessionId } : {},
      'test',
      `test-cost:${randomUUID()}`,
      opts.seat,
      opts.trigger,
      opts.model,
      opts.tokensIn,
      opts.tokensOut,
      opts.estCost,
      opts.approx,
    ],
  )
}

function findBucket(scale: CostScale, triggerClass: string) {
  return scale.breakdown.find((b) => b.triggerClass === triggerClass)
}

// Section B: the reporting surface (bion cost) + the sanity guard, over a shared test DB —
// every assertion is scoped to a unique trigger_class tag so concurrent tests' rows can't interfere
// (same convention as status.test.ts's before/after deltas).
describe('bion cost (directive-18 §Section B)', () => {
  it('groups by seat × trigger_class × model at the session scale, keyed by payload.sessionId', async () => {
    const trigger = `t-session-${randomUUID().slice(0, 8)}`
    const sessionId = `sess-${randomUUID()}`
    const now = new Date()
    await insertCostEvent({ seat: 'kov', trigger, model: 'claude-sonnet-5', tokensIn: 100, tokensOut: 50, estCost: 0.01, approx: false, ts: now, sessionId })
    await insertCostEvent({ seat: 'kov', trigger, model: 'claude-sonnet-5', tokensIn: 200, tokensOut: 75, estCost: 0.02, approx: false, ts: now, sessionId })

    const d = await collectCost({ now })
    const bucket = findBucket(d.session, trigger)
    expect(bucket).toBeTruthy()
    expect(bucket!.sessionKey).toBe(sessionId)
    expect(bucket!.tokensIn).toBe(300)
    expect(bucket!.tokensOut).toBe(125)
    expect(bucket!.estCost).toBeCloseTo(0.03)
    expect(bucket!.events).toBe(2)
  })

  it('24h and 30d scales include events inside their window and exclude events outside it', async () => {
    const trigger = `t-window-${randomUUID().slice(0, 8)}`
    const sessionId = `sess-window-${randomUUID()}` // shared, so all three collapse into one session bucket
    const now = new Date('2026-07-29T12:00:00.000Z')
    const inLast24h = new Date(now.getTime() - 1 * 60 * 60 * 1000)
    const inLast30dNotLast24h = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
    const outsideBoth = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000)

    await insertCostEvent({ seat: 'kov', trigger, model: 'm', tokensIn: 1, tokensOut: 1, estCost: 0.001, approx: false, ts: inLast24h, sessionId })
    await insertCostEvent({ seat: 'kov', trigger, model: 'm', tokensIn: 10, tokensOut: 10, estCost: 0.01, approx: false, ts: inLast30dNotLast24h, sessionId })
    await insertCostEvent({ seat: 'kov', trigger, model: 'm', tokensIn: 100, tokensOut: 100, estCost: 0.1, approx: false, ts: outsideBoth, sessionId })

    const d = await collectCost({ now })
    expect(findBucket(d.daily, trigger)!.events).toBe(1)
    expect(findBucket(d.daily, trigger)!.tokensIn).toBe(1)
    expect(findBucket(d.monthly, trigger)!.events).toBe(2)
    expect(findBucket(d.monthly, trigger)!.tokensIn).toBe(11)
    expect(findBucket(d.session, trigger)!.events).toBe(3) // session scale is all-time
  })

  it('sanity guard excludes an out-of-range row from every total and counts it as flagged', async () => {
    const goodTrigger = `t-guard-good-${randomUUID().slice(0, 8)}`
    const badTrigger = `t-guard-bad-${randomUUID().slice(0, 8)}`
    const now = new Date()
    const before = await collectCost({ now })

    await insertCostEvent({ seat: 'kov', trigger: goodTrigger, model: 'm', tokensIn: 5, tokensOut: 5, estCost: 0.001, approx: false, ts: now })
    // est_cost way past MAX_COST_PER_EVENT — a corrupted/garbage read, not a legitimately big turn.
    await insertCostEvent({ seat: 'kov', trigger: badTrigger, model: 'm', tokensIn: 5, tokensOut: 5, estCost: 999_999, approx: false, ts: now })

    const after = await collectCost({ now })
    expect(findBucket(after.session, goodTrigger)).toBeTruthy()
    expect(findBucket(after.session, badTrigger)).toBeUndefined() // excluded, not merely under-counted
    expect(after.flagged).toBe(before.flagged + 1)
  })

  it('a negative token count is also flagged and excluded', async () => {
    const trigger = `t-guard-neg-${randomUUID().slice(0, 8)}`
    const now = new Date()
    const before = await collectCost({ now })

    await insertCostEvent({ seat: 'kov', trigger, model: 'm', tokensIn: -1, tokensOut: 5, estCost: 0.001, approx: false, ts: now })

    const after = await collectCost({ now })
    expect(findBucket(after.session, trigger)).toBeUndefined()
    expect(after.flagged).toBe(before.flagged + 1)
  })

  it('is_approximate propagates to the bucket', async () => {
    const trigger = `t-approx-${randomUUID().slice(0, 8)}`
    const now = new Date()
    await insertCostEvent({ seat: 'desktop', trigger, model: 'unknown', tokensIn: 10, tokensOut: 0, estCost: 0, approx: true, ts: now })

    const d = await collectCost({ now })
    expect(findBucket(d.session, trigger)!.approximate).toBe(true)
  })

  it('formatCost renders all three scale headers, and a flagged-count footer when applicable', async () => {
    const trigger = `t-format-${randomUUID().slice(0, 8)}`
    const now = new Date()
    await insertCostEvent({ seat: 'kov', trigger, model: 'm', tokensIn: 1, tokensOut: 1, estCost: 5_000, approx: false, ts: now }) // ensure >0 flagged

    const d = await collectCost({ now })
    const text = formatCost(d)
    expect(text).toContain('BION COST')
    expect(text).toContain('SESSION')
    expect(text).toContain('LAST 24H')
    expect(text).toContain('LAST 30D')
    expect(text).toMatch(/flagged/)
  })
})
