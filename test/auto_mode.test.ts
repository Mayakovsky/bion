import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runAutoStep,
  selectAutoWork,
  desktopLaunchRead,
  createTask,
  getTask,
  setTaskStatus,
  KovAdapter,
  DesktopAdapter,
  query,
  type NotifyInput,
  type AutoDeps,
} from '../src/index.js'
import { ratifyAsForces, seedProject } from './helpers.js'

const freshRoot = () => join(tmpdir(), `bion-mail-${randomUUID()}`)
const capture = () => {
  const calls: NotifyInput[] = []
  return { calls, notify: async (i: NotifyInput) => (calls.push(i), { sent: true, dryRun: false, status: 200 }) }
}
const breakerOff = { max: 1_000_000_000, windowMs: 1 }
const TEN_YEARS_MS = 315_360_000_000

/** Current lowest active-project ordinal, so a test project can sort strictly first (global top). */
async function minOrdinal(): Promise<number> {
  const r = await query<{ m: string }>(`SELECT COALESCE(min(ordinal), 0)::text AS m FROM projects WHERE active`)
  return Number(r.rows[0]!.m)
}
async function ratifiedTaskInTopProject(opts: { owner?: string; ordinalOffset?: number } = {}): Promise<string> {
  const proj = `proj-${randomUUID()}`
  await seedProject(proj, (await minOrdinal()) + (opts.ordinalOffset ?? -1))
  const id = `t-${randomUUID()}`
  await createTask({ id, title: 'auto work', project: proj, owner: opts.owner, priority: 10 })
  await ratifyAsForces(id)
  return id
}

describe('Auto Mode — ordered projects, pivot-on-block, shadow-gated (E3)', () => {
  it('pivot-on-block: skips a blocked earlier-project task and advances to the next', async () => {
    const base = await minOrdinal()
    const blockedProj = `proj-${randomUUID()}`
    const nextProj = `proj-${randomUUID()}`
    await seedProject(blockedProj, base - 2) // earlier
    await seedProject(nextProj, base - 1) // later, but still ahead of everything else
    const blocked = `t-${randomUUID()}`
    const nextTask = `t-${randomUUID()}`
    await createTask({ id: blocked, title: 'roadblock', project: blockedProj, priority: 10 })
    await createTask({ id: nextTask, title: 'next front', project: nextProj, priority: 10 })
    await ratifyAsForces(blocked)
    await ratifyAsForces(nextTask)
    await setTaskStatus(blocked, 'blocked')

    const pick = await selectAutoWork()
    expect(pick).not.toBeNull()
    expect(pick!.task.id).toBe(nextTask)
    expect(pick!.pivoted).toBe(true)
  })

  it('shadow: logs the would-dispatch + notifies, executes nothing', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    const id = await ratifiedTaskInTopProject()

    const deps: AutoDeps = { kov, mailRoot: root, notify, mode: 'shadow', breaker: breakerOff }
    const r = await runAutoStep(deps)
    expect(r.dispatched).toBe(false)
    expect(r.selected?.taskId).toBe(id)
    expect(r.wouldDispatch).toEqual({ taskId: id, owner: 'kov' })
    expect((await kov.pollStatus()).consumed).toHaveLength(0)
    expect((await getTask(id))!.status).toBe('backlog') // untouched
    const ev = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind='auto.shadow' AND payload->>'taskId'=$1`, [id])
    expect(Number(ev.rows[0]!.n)).toBe(1)
  })

  it('on: auto-dispatches ratified work to Kov and marks it in_progress', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    const id = await ratifiedTaskInTopProject()

    const r = await runAutoStep({ kov, mailRoot: root, notify, mode: 'on', breaker: breakerOff })
    expect(r.dispatched).toBe(true)
    expect(r.selected?.taskId).toBe(id)
    const kpoll = await kov.pollStatus()
    expect(kpoll.consumed).toHaveLength(1)
    expect(kpoll.consumed[0]!.content).toContain('Auto-dispatched task')
    expect((await getTask(id))!.status).toBe('in_progress')
  })

  it('on: the circuit breaker (spend ceiling) halts once the window count is hit', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    const id = await ratifiedTaskInTopProject()
    const base = Number(
      (await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind IN ('reactive.dispatch','auto.dispatch')`)).rows[0]!.n,
    )
    const r = await runAutoStep({ kov, mailRoot: root, notify, mode: 'on', breaker: { max: base, windowMs: TEN_YEARS_MS } })
    expect(r.dispatched).toBe(false)
    expect(r.halted).toBe('circuit-breaker')
    expect((await getTask(id))!.status).toBe('backlog') // withheld
  })

  it('on: a Desktop-owned item is QUEUED for Desktop, not executed by Kov', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const desktop = new DesktopAdapter({ mailRoot: root })
    const { notify } = capture()
    const id = await ratifiedTaskInTopProject({ owner: 'desktop' })

    const r = await runAutoStep({ kov, mailRoot: root, notify, mode: 'on', breaker: breakerOff })
    expect(r.dispatched).toBe(false)
    expect(r.queuedForDesktop).toBe(true)
    expect((await kov.pollStatus()).consumed).toHaveLength(0) // Kov did not execute it
    const dpoll = await desktop.pollStatus()
    expect(dpoll.consumed).toHaveLength(1) // queued for Desktop
    expect((await getTask(id))!.status).toBe('in_progress') // left the front
  })

  it('Desktop auto-reads its inbox at launch', async () => {
    const root = freshRoot()
    const desktop = new DesktopAdapter({ mailRoot: root })
    await desktop.dispatch({ sender: 'bion', recipient: 'desktop', body: `launch ${randomUUID()}`, origin: 'bion' })
    const read = await desktopLaunchRead({ mailRoot: root })
    expect(read.consumed).toHaveLength(1)
  })
})
