import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  handleTestSignal,
  KovAdapter,
  createTask,
  getTask,
  bindBranch,
  parseBindBranchArgs,
  type NotifyInput,
  type ReactiveDeps,
} from '../src/index.js'
import { ratifyAsForces, deleteTasksAsForces } from './helpers.js'

const freshRoot = () => join(tmpdir(), `bion-mail-${randomUUID()}`)
const capture = () => {
  const calls: NotifyInput[] = []
  return { calls, notify: async (i: NotifyInput) => (calls.push(i), { sent: true, dryRun: false, status: 200 }) }
}
const breakerOff = { max: 1_000_000_000, windowMs: 1 }

const failSig = (branch: string, runId: string) => ({
  kind: 'test' as const,
  repo: 'bion',
  branch,
  passed: false,
  failed: 1,
  total: 1,
  failedTests: ['x'],
  runId,
})

describe('bindBranch (directive-91 Task 3 — the real binding mechanism)', () => {
  it('binds a ratified task to an arbitrary, non-bion/-prefixed branch', async () => {
    const taskId = `bb-${randomUUID()}`
    await createTask({ id: taskId, title: 'grey-repo work' })
    await ratifyAsForces(taskId)

    const arbitraryBranch = `feature/gnosis-wallet-${randomUUID()}` // real grey-culture naming, no task id embedded
    const bound = await bindBranch(taskId, arbitraryBranch)
    expect(bound).not.toBeNull()
    expect(bound!.branch).toBe(arbitraryBranch)

    const reread = await getTask(taskId)
    expect(reread!.branch).toBe(arbitraryBranch)

    await deleteTasksAsForces([taskId])
  })

  it('refuses to bind an unratified task (mirrors the not-ratified-branch gate)', async () => {
    const taskId = `bb-unrat-${randomUUID()}`
    await createTask({ id: taskId, title: 'not yet ratified' })
    // deliberately not ratified

    const bound = await bindBranch(taskId, `feature/whatever-${randomUUID()}`)
    expect(bound).toBeNull()

    const reread = await getTask(taskId)
    expect(reread!.branch).toBeNull() // no dangling half-write

    await deleteTasksAsForces([taskId])
  })

  it('parseBindBranchArgs requires both positionals', () => {
    expect(() => parseBindBranchArgs([])).toThrow(/usage/)
    expect(() => parseBindBranchArgs(['only-id'])).toThrow(/usage/)
    expect(parseBindBranchArgs(['t-1', 'feature/x'])).toEqual({ id: 't-1', branch: 'feature/x' })
  })
})

describe('ratifiedTaskForBranch — both real paths, through the actual reactive flow', () => {
  it('path A (fallback, unchanged): a bion/<taskId> branch resolves without any explicit binding', async () => {
    const taskId = `path-a-${randomUUID()}`
    await createTask({ id: taskId, title: 'bion-style branch, no binding needed' })
    await ratifyAsForces(taskId)
    const branch = `bion/${taskId}` // the pre-existing FEATURE_PREFIX convention — never bound explicitly

    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    try {
      const deps: ReactiveDeps = { kov, mailRoot: root, notify, mode: 'on', breaker: breakerOff }
      const r = await handleTestSignal(failSig(branch, randomUUID()), deps)
      expect(r.dispatched).toBe(true)
      expect(r.taskId).toBe(taskId) // resolved via the string-match fallback, exactly as before
    } finally {
      await deleteTasksAsForces([taskId])
    }
  })

  it('path B (new, explicit): an arbitrary non-bion/-prefixed branch resolves only once bound', async () => {
    const taskId = `path-b-${randomUUID()}`
    await createTask({ id: taskId, title: 'grey-repo work, real explicit binding' })
    await ratifyAsForces(taskId)
    const branch = `main-gnosis-adapter-${randomUUID()}` // no bion/ prefix at all — the exact case the old code could never resolve

    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const { notify } = capture()
    try {
      const deps: ReactiveDeps = { kov, mailRoot: root, notify, mode: 'on', breaker: breakerOff }

      // Before binding: genuinely unresolvable, same as any unrelated branch — proves this isn't
      // accidentally passing via the fallback string-match (it has no bion/ prefix to match).
      const before = await handleTestSignal(failSig(branch, randomUUID()), deps)
      expect(before.dispatched).toBe(false)
      expect(before.halted).toBe('not-ratified-branch')

      // Real binding, the actual Task 3 mechanism:
      const bound = await bindBranch(taskId, branch)
      expect(bound!.branch).toBe(branch)

      // After binding: resolves via the explicit `branch` column lookup, not the string convention.
      const after = await handleTestSignal(failSig(branch, randomUUID()), deps)
      expect(after.dispatched).toBe(true)
      expect(after.taskId).toBe(taskId)
    } finally {
      await deleteTasksAsForces([taskId])
    }
  })
})
