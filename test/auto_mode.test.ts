import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runAutoStep,
  selectAutoWork,
  desktopLaunchRead,
  autoModeSetting,
  createTask,
  getTask,
  setTaskStatus,
  KovAdapter,
  DesktopAdapter,
  query,
  type NotifyInput,
  type AutoDeps,
} from '../src/index.js'
import { ratifyAsForces, seedProject, deleteTasksAsForces, deleteProjectAsForces } from './helpers.js'

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
async function ratifiedTaskInTopProject(opts: { owner?: string; ordinalOffset?: number } = {}): Promise<{ id: string; project: string }> {
  const proj = `proj-${randomUUID()}`
  await seedProject(proj, (await minOrdinal()) + (opts.ordinalOffset ?? -1))
  const id = `t-${randomUUID()}`
  await createTask({ id, title: 'auto work', project: proj, owner: opts.owner, priority: 10 })
  await ratifyAsForces(id)
  return { id, project: proj }
}

/** Teardown for ratifiedTaskInTopProject() — deletes the task then its scratch project. */
async function cleanupRatifiedTask(t: { id: string; project: string }): Promise<void> {
  await deleteTasksAsForces([t.id])
  await deleteProjectAsForces(t.project)
}

describe('Auto Mode default posture (directive-20: off -> shadow)', () => {
  it('autoModeSetting() falls back to shadow when BION_AUTO_MODE is fully unset', () => {
    const had = 'BION_AUTO_MODE' in process.env
    const prior = process.env.BION_AUTO_MODE
    delete process.env.BION_AUTO_MODE
    try {
      expect(autoModeSetting()).toBe('shadow')
    } finally {
      if (had) process.env.BION_AUTO_MODE = prior
    }
  })

  it('off and on remain fully available as explicit settings', () => {
    const prior = process.env.BION_AUTO_MODE
    try {
      process.env.BION_AUTO_MODE = 'off'
      expect(autoModeSetting()).toBe('off')
      process.env.BION_AUTO_MODE = 'on'
      expect(autoModeSetting()).toBe('on')
    } finally {
      if (prior === undefined) delete process.env.BION_AUTO_MODE
      else process.env.BION_AUTO_MODE = prior
    }
  })
})

describe('BION_AUTO_SCOPE task-scope filter (directive-23 Part B)', () => {
  it('unset: selects the front task exactly as today, unfiltered', async () => {
    const had = 'BION_AUTO_SCOPE' in process.env
    const prior = process.env.BION_AUTO_SCOPE
    delete process.env.BION_AUTO_SCOPE
    const task = await ratifiedTaskInTopProject()
    try {
      const pick = await selectAutoWork()
      expect(pick).not.toBeNull()
      expect(pick!.task.id).toBe(task.id)
    } finally {
      if (had) process.env.BION_AUTO_SCOPE = prior
      await cleanupRatifiedTask(task)
    }
  })

  it('set to a prefix matching nothing: returns null even though other ratified/ready tasks exist', async () => {
    const had = 'BION_AUTO_SCOPE' in process.env
    const prior = process.env.BION_AUTO_SCOPE
    const task = await ratifiedTaskInTopProject() // exists, ratified, ready — but not e3-*
    try {
      process.env.BION_AUTO_SCOPE = 'e3-'
      const pick = await selectAutoWork()
      expect(pick).toBeNull()
    } finally {
      if (had) process.env.BION_AUTO_SCOPE = prior
      else delete process.env.BION_AUTO_SCOPE
      await cleanupRatifiedTask(task)
    }
  })

  it('set to a matching prefix: selects the in-scope task even though an out-of-scope task ranks first', async () => {
    const had = 'BION_AUTO_SCOPE' in process.env
    const prior = process.env.BION_AUTO_SCOPE
    // outOfScope sorts FIRST (top ordinal) so, unfiltered, it's the one selectAutoWork() would pick —
    // proving the scope filter actively excludes it, not that inScope merely happened to rank higher.
    const outOfScope = await ratifiedTaskInTopProject()
    const inScopeProj = `proj-${randomUUID()}`
    const inScopeId = `e3-${randomUUID()}`
    try {
      await seedProject(inScopeProj, 2147483646) // last-ranked, ordinally after everything
      await createTask({ id: inScopeId, title: 'e3 work', project: inScopeProj, priority: 10 })
      await ratifyAsForces(inScopeId)

      process.env.BION_AUTO_SCOPE = 'e3-'
      const pick = await selectAutoWork()
      expect(pick).not.toBeNull()
      expect(pick!.task.id).toBe(inScopeId)
    } finally {
      if (had) process.env.BION_AUTO_SCOPE = prior
      else delete process.env.BION_AUTO_SCOPE
      await deleteTasksAsForces([inScopeId])
      await deleteProjectAsForces(inScopeProj)
      await cleanupRatifiedTask(outOfScope)
    }
  })
})

describe('Auto Mode — ordered projects, pivot-on-block, shadow-gated (E3)', () => {
  it('pivot-on-block: skips a blocked earlier-project task and advances to the next', async () => {
    const base = await minOrdinal()
    const blockedProj = `proj-${randomUUID()}`
    const nextProj = `proj-${randomUUID()}`
    await seedProject(blockedProj, base - 2) // earlier
    await seedProject(nextProj, base - 1) // later, but still ahead of everything else
    const blocked = `t-${randomUUID()}`
    const nextTask = `t-${randomUUID()}`
    try {
      await createTask({ id: blocked, title: 'roadblock', project: blockedProj, priority: 10 })
      await createTask({ id: nextTask, title: 'next front', project: nextProj, priority: 10 })
      await ratifyAsForces(blocked)
      await ratifyAsForces(nextTask)
      await setTaskStatus(blocked, 'blocked')

      const pick = await selectAutoWork()
      expect(pick).not.toBeNull()
      expect(pick!.task.id).toBe(nextTask)
      expect(pick!.pivoted).toBe(true)
    } finally {
      await deleteTasksAsForces([blocked, nextTask])
      await deleteProjectAsForces(blockedProj)
      await deleteProjectAsForces(nextProj)
    }
  })

  it('shadow: logs the would-dispatch + notifies, executes nothing', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    const task = await ratifiedTaskInTopProject()

    try {
      const deps: AutoDeps = { kov, mailRoot: root, notify, mode: 'shadow', breaker: breakerOff }
      const r = await runAutoStep(deps)
      expect(r.dispatched).toBe(false)
      expect(r.selected?.taskId).toBe(task.id)
      expect(r.wouldDispatch).toEqual({ taskId: task.id, owner: 'kov' })
      expect((await kov.pollStatus()).consumed).toHaveLength(0)
      expect((await getTask(task.id))!.status).toBe('backlog') // untouched
      const ev = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind='auto.shadow' AND payload->>'taskId'=$1`, [task.id])
      expect(Number(ev.rows[0]!.n)).toBe(1)
    } finally {
      await cleanupRatifiedTask(task)
    }
  })

  it('on: auto-dispatches ratified work to Kov and marks it in_progress', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    const task = await ratifiedTaskInTopProject()

    try {
      const r = await runAutoStep({ kov, mailRoot: root, notify, mode: 'on', breaker: breakerOff })
      expect(r.dispatched).toBe(true)
      expect(r.selected?.taskId).toBe(task.id)
      const kpoll = await kov.pollStatus()
      expect(kpoll.consumed).toHaveLength(1)
      expect(kpoll.consumed[0]!.content).toContain('@intent dispatch')
      expect((await getTask(task.id))!.status).toBe('in_progress')
    } finally {
      await cleanupRatifiedTask(task)
    }
  })

  it('on: the circuit breaker (spend ceiling) halts once the window count is hit', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    const task = await ratifiedTaskInTopProject()
    try {
      const base = Number(
        (await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind IN ('reactive.dispatch','auto.dispatch')`)).rows[0]!.n,
      )
      const r = await runAutoStep({ kov, mailRoot: root, notify, mode: 'on', breaker: { max: base, windowMs: TEN_YEARS_MS } })
      expect(r.dispatched).toBe(false)
      expect(r.halted).toBe('circuit-breaker')
      expect((await getTask(task.id))!.status).toBe('backlog') // withheld
    } finally {
      await cleanupRatifiedTask(task)
    }
  })

  it('on: a Desktop-owned item is QUEUED for Desktop, not executed by Kov', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const desktop = new DesktopAdapter({ mailRoot: root })
    const { notify } = capture()
    const task = await ratifiedTaskInTopProject({ owner: 'desktop' })

    try {
      const r = await runAutoStep({ kov, mailRoot: root, notify, mode: 'on', breaker: breakerOff })
      expect(r.dispatched).toBe(false)
      expect(r.queuedForDesktop).toBe(true)
      expect((await kov.pollStatus()).consumed).toHaveLength(0) // Kov did not execute it
      const dpoll = await desktop.pollStatus()
      expect(dpoll.consumed).toHaveLength(1) // queued for Desktop
      expect((await getTask(task.id))!.status).toBe('in_progress') // left the front
    } finally {
      await cleanupRatifiedTask(task)
    }
  })

  it('Desktop auto-reads its inbox at launch', async () => {
    const root = freshRoot()
    const desktop = new DesktopAdapter({ mailRoot: root })
    await desktop.dispatch({ sender: 'bion', recipient: 'desktop', body: `launch ${randomUUID()}`, origin: 'bion' })
    const read = await desktopLaunchRead({ mailRoot: root })
    expect(read.consumed).toHaveLength(1)
  })
})
