import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseVitestJson,
  handleGitSignal,
  handleTestSignal,
  commitSignal,
  KovAdapter,
  DesktopAdapter,
  getTask,
  query,
  type NotifyInput,
} from '../src/index.js'

const freshRoot = () => join(tmpdir(), `bion-mail-${randomUUID()}`)
const capture = () => {
  const calls: NotifyInput[] = []
  return { calls, notify: async (i: NotifyInput) => (calls.push(i), { sent: true, dryRun: false, status: 200 }) }
}

describe('test-output watcher parses vitest JSON', () => {
  it('normalizes a failing run into a signal with the failed test names', () => {
    const sig = parseVitestJson(
      {
        numTotalTests: 3,
        numFailedTests: 1,
        testResults: [
          { name: 'a.test.ts', assertionResults: [
            { fullName: 'a > works', status: 'passed' },
            { fullName: 'a > broken', status: 'failed' },
          ] },
        ],
      },
      { branch: 'bion/x', runId: 'r1' },
    )
    expect(sig.passed).toBe(false)
    expect(sig.failed).toBe(1)
    expect(sig.total).toBe(3)
    expect(sig.failedTests).toEqual(['a > broken'])
  })

  it('marks a clean run as passed', () => {
    const sig = parseVitestJson({ numTotalTests: 2, numFailedTests: 0 }, { branch: 'b', runId: 'r2' })
    expect(sig.passed).toBe(true)
    expect(sig.failedTests).toEqual([])
  })
})

describe('git watcher emits idempotent events', () => {
  it('collapses a duplicate commit signal (dedup by sha)', async () => {
    const sha = `sha-${randomUUID()}`
    expect((await handleGitSignal(commitSignal('main', sha))).duplicate).toBe(false)
    expect((await handleGitSignal(commitSignal('main', sha))).duplicate).toBe(true)
    const ev = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM events WHERE kind = 'git.commit' AND dedup_key = $1`,
      [`git:commit:${sha}`],
    )
    expect(ev.rows[0]!.n).toBe('1')
  })
})

// Gate D2 (=off): failing test → unratified task + notify, no dispatch; passing → nothing;
// duplicate signals collapse.
describe('reactive mode = off (default live behavior)', () => {
  it('surfaces an unratified task + notifies, dispatches nothing, and collapses duplicates', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    const desktop = new DesktopAdapter({ mailRoot: root })
    const { calls, notify } = capture()
    const runId = randomUUID()
    const branch = `bion/none-${randomUUID()}`
    const sig = { kind: 'test' as const, branch, passed: false, failed: 1, total: 3, failedTests: ['a > b'], runId }

    const r = await handleTestSignal(sig, { kov, mailRoot: root, notify, mode: 'off' })
    expect(r.duplicate).toBe(false)
    expect(r.dispatched).toBe(false)
    expect(r.taskId).toBeTruthy()
    const task = await getTask(r.taskId!)
    expect(task).toBeTruthy()
    expect(task!.ratified).toBe(false) // never auto-ratified (inv 13 / FDQ-B3)
    expect(calls).toHaveLength(1)
    expect((await kov.pollStatus()).consumed).toHaveLength(0) // NO dispatch to Kov
    expect((await desktop.pollStatus()).consumed).toHaveLength(1) // review queued for Desktop

    // duplicate signal collapses — no second task action, no second notify
    const dup = await handleTestSignal(sig, { kov, mailRoot: root, notify, mode: 'off' })
    expect(dup.duplicate).toBe(true)
    expect(calls).toHaveLength(1)

    // a passing run does nothing
    const pass = await handleTestSignal(
      { kind: 'test', branch, passed: true, failed: 0, total: 3, failedTests: [], runId: randomUUID() },
      { kov, mailRoot: root, notify, mode: 'off' },
    )
    expect(pass.dispatched).toBe(false)
    expect(pass.taskId).toBeUndefined()
    expect(calls).toHaveLength(1)
  })
})
