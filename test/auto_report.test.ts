import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { query, collectAutoReport, formatAutoReport } from '../src/index.js'

async function insertShadowEvent(opts: {
  taskId: string
  project: string
  owner: string
  pivoted: boolean
  ts: Date
}): Promise<void> {
  await query(
    `INSERT INTO events (ts, kind, payload, source, dedup_key)
     VALUES ($1, 'auto.shadow', $2, 'test', $3)`,
    [opts.ts, { taskId: opts.taskId, project: opts.project, owner: opts.owner, pivoted: opts.pivoted }, `auto.shadow:${opts.taskId}`],
  )
}

function findTask(d: Awaited<ReturnType<typeof collectAutoReport>>, taskId: string) {
  return d.tasks.find((t) => t.taskId === taskId)
}

// directive-19 §4: aggregate view + distinct-task list over auto.shadow, at all-time/24h/30d.
describe('bion auto-report', () => {
  it('aggregates total, by-project, by-owner, and pivoted count at the all-time scale', async () => {
    const project = `proj-${randomUUID().slice(0, 8)}`
    const now = new Date()
    const t1 = `t-${randomUUID()}`
    const t2 = `t-${randomUUID()}`
    await insertShadowEvent({ taskId: t1, project, owner: 'kov', pivoted: false, ts: now })
    await insertShadowEvent({ taskId: t2, project, owner: 'desktop', pivoted: true, ts: now })

    const d = await collectAutoReport({ now })
    expect(d.allTime.byProject[project]).toBe(2)
    expect(d.allTime.byOwner.kov).toBeGreaterThanOrEqual(1)
    expect(d.allTime.byOwner.desktop).toBeGreaterThanOrEqual(1)
    expect(findTask(d, t1)).toMatchObject({ project, owner: 'kov', pivoted: false })
    expect(findTask(d, t2)).toMatchObject({ project, owner: 'desktop', pivoted: true })
  })

  it('24h and 30d windows include/exclude by ts, same convention as bion cost', async () => {
    const project = `proj-window-${randomUUID().slice(0, 8)}`
    const now = new Date('2026-07-29T12:00:00.000Z')
    const inLast24h = new Date(now.getTime() - 1 * 60 * 60 * 1000)
    const inLast30dOnly = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
    const outsideBoth = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000)

    const tA = `t-${randomUUID()}`
    const tB = `t-${randomUUID()}`
    const tC = `t-${randomUUID()}`
    await insertShadowEvent({ taskId: tA, project, owner: 'kov', pivoted: false, ts: inLast24h })
    await insertShadowEvent({ taskId: tB, project, owner: 'kov', pivoted: false, ts: inLast30dOnly })
    await insertShadowEvent({ taskId: tC, project, owner: 'kov', pivoted: false, ts: outsideBoth })

    const d = await collectAutoReport({ now })
    expect(d.daily.byProject[project]).toBe(1)
    expect(d.monthly.byProject[project]).toBe(2)
    expect(d.allTime.byProject[project]).toBe(3)
  })

  it('a malformed payload (no taskId) is skipped, not thrown or counted', async () => {
    const before = await collectAutoReport()
    await query(`INSERT INTO events (ts, kind, payload, source, dedup_key) VALUES (now(), 'auto.shadow', $1, 'test', $2)`, [
      { project: 'x', owner: 'kov' }, // no taskId
      `auto.shadow:malformed-${randomUUID()}`,
    ])
    const after = await collectAutoReport()
    expect(after.skipped).toBe(before.skipped + 1)
    expect(after.allTime.total).toBe(before.allTime.total) // not counted as a real pick
  })

  it('dedup_key auto.shadow:<task.id> means one row per task, not per tick — a re-pick collapses', async () => {
    const taskId = `t-${randomUUID()}`
    const project = `proj-${randomUUID().slice(0, 8)}`
    // simulate two ticks re-picking the same front task — recordEvent's ON CONFLICT would collapse
    // this in the real system; here we just confirm collectAutoReport doesn't double-count if it does.
    await query(
      `INSERT INTO events (ts, kind, payload, source, dedup_key) VALUES (now(), 'auto.shadow', $1, 'test', $2)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [{ taskId, project, owner: 'kov', pivoted: false }, `auto.shadow:${taskId}`],
    )
    await query(
      `INSERT INTO events (ts, kind, payload, source, dedup_key) VALUES (now(), 'auto.shadow', $1, 'test', $2)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [{ taskId, project, owner: 'kov', pivoted: false }, `auto.shadow:${taskId}`],
    )
    const d = await collectAutoReport()
    expect(d.tasks.filter((t) => t.taskId === taskId)).toHaveLength(1)
  })

  it('formatAutoReport renders all sections and a skipped-count footer when applicable', async () => {
    const d = await collectAutoReport()
    const text = formatAutoReport(d)
    expect(text).toContain('BION AUTO-REPORT')
    expect(text).toContain('ALL-TIME')
    expect(text).toContain('LAST 24H')
    expect(text).toContain('LAST 30D')
    expect(text).toContain('DISTINCT TASKS')
  })
})
