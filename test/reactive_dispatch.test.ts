import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  handleTestSignal,
  KovAdapter,
  createTask,
  getTask,
  query,
  type NotifyInput,
  type ReactiveDeps,
} from '../src/index.js'
import { ratifyAsForces } from './helpers.js'

const freshRoot = () => join(tmpdir(), `bion-mail-${randomUUID()}`)
const capture = () => {
  const calls: NotifyInput[] = []
  return { calls, notify: async (i: NotifyInput) => (calls.push(i), { sent: true, dryRun: false, status: 200 }) }
}
// A window so tiny it counts ~nothing + a huge max => the circuit breaker never trips.
const breakerOff = { max: 1_000_000_000, windowMs: 1 }

async function ratifiedBranch(): Promise<{ taskId: string; branch: string }> {
  const taskId = `rt-${randomUUID()}`
  await createTask({ id: taskId, title: 'ratified work' })
  await ratifyAsForces(taskId)
  return { taskId, branch: `bion/${taskId}` }
}

const failSig = (branch: string, runId: string) => ({
  kind: 'test' as const,
  branch,
  passed: false,
  failed: 1,
  total: 1,
  failedTests: ['x'],
  runId,
})

describe('reactive dispatch — bounded envelope (built now, shipped off)', () => {
  it('shadow: logs the would-dispatch + notifies, fires nothing', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { calls, notify } = capture()
    const { taskId, branch } = await ratifiedBranch()

    const deps: ReactiveDeps = { kov, mailRoot: root, notify, mode: 'shadow', breaker: breakerOff }
    const r = await handleTestSignal(failSig(branch, randomUUID()), deps)

    expect(r.dispatched).toBe(false)
    expect(r.wouldDispatch).toEqual({ taskId, targetBranch: branch, trigger: 'test.failed' })
    expect((await kov.pollStatus()).consumed).toHaveLength(0) // nothing fired
    const ev = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM events WHERE kind = 'reactive.shadow' AND payload->>'taskId' = $1`,
      [taskId],
    )
    expect(Number(ev.rows[0]!.n)).toBeGreaterThanOrEqual(1)
  })

  it('on: dispatches once on a ratified branch, then loop-halts a repeat failure', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    const { taskId, branch } = await ratifiedBranch()
    const deps: ReactiveDeps = { kov, mailRoot: root, notify, mode: 'on', breaker: breakerOff }

    const runId1 = `run1-${randomUUID()}`
    const r1 = await handleTestSignal(failSig(branch, runId1), deps)
    expect(r1.dispatched).toBe(true)
    expect(r1.taskId).toBe(taskId)
    const kpoll = await kov.pollStatus()
    expect(kpoll.consumed).toHaveLength(1)
    expect(kpoll.consumed[0]!.content).toContain('Auto-fix dispatch')

    // exactly once: same runId re-feed is a deduped no-op
    const dup = await handleTestSignal(failSig(branch, runId1), deps)
    expect(dup.duplicate).toBe(true)
    expect(dup.dispatched).toBe(false)

    // a fresh failure on the same task loop-halts (never re-dispatches)
    const r2 = await handleTestSignal(failSig(branch, `run2-${randomUUID()}`), deps)
    expect(r2.dispatched).toBe(false)
    expect(r2.halted).toBe('loop-halt')
    expect((await kov.pollStatus()).consumed).toHaveLength(0) // no new packet fired
  })

  it('on: the circuit breaker halts once the window ceiling is hit', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    const a = await ratifiedBranch()
    const b = await ratifiedBranch()

    // Set the ceiling to exactly one more than the current global count of auto-dispatches,
    // so the first new dispatch reaches it and the second trips.
    const base = Number(
      (await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = 'reactive.dispatch'`)).rows[0]!.n,
    )
    const deps: ReactiveDeps = { kov, mailRoot: root, notify, mode: 'on', breaker: { max: base + 1, windowMs: 10_000_000 } }

    const rA = await handleTestSignal(failSig(a.branch, randomUUID()), deps)
    expect(rA.dispatched).toBe(true)

    const rB = await handleTestSignal(failSig(b.branch, randomUUID()), deps)
    expect(rB.dispatched).toBe(false)
    expect(rB.halted).toBe('circuit-breaker')
  })

  it('on: an off-branch / non-ratified failure does not dispatch (surfaces instead)', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    const deps: ReactiveDeps = { kov, mailRoot: root, notify, mode: 'on', breaker: breakerOff }

    const r = await handleTestSignal(failSig(`feature/random-${randomUUID()}`, randomUUID()), deps)
    expect(r.dispatched).toBe(false)
    expect(r.halted).toBe('not-ratified-branch')
    expect((await kov.pollStatus()).consumed).toHaveLength(0)
    expect(await getTask(r.taskId!)).toBeTruthy() // surfaced an unratified task
  })
})
