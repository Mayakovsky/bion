import { recordEvent } from '../core/events.js'
import { onTestFailure, reactiveMode, type ReactiveDeps, type ReactiveMode, type ReactiveOutcome } from '../loop/reactive.js'
import { collectKovCost } from '../cost/kovCollector.js'
import type { BionEvent } from '../core/types.js'
import type { GitSignal, TestSignal } from './types.js'

// Watcher → Bion: each signal first records an idempotent Bion event (duplicate signals collapse),
// then a test-FAILURE signal runs the reactive engine per the active mode.

export interface TestHandleResult extends Partial<ReactiveOutcome> {
  duplicate: boolean
  passed: boolean
  mode: ReactiveMode
  dispatched: boolean
}

export async function handleTestSignal(signal: TestSignal, deps: ReactiveDeps): Promise<TestHandleResult> {
  const mode = deps.mode ?? reactiveMode()
  const { deduped } = await recordEvent({
    kind: signal.passed ? 'test.passed' : 'test.failed',
    source: 'watcher:test',
    payload: {
      repo: signal.repo,
      branch: signal.branch,
      failed: signal.failed,
      total: signal.total,
      failedTests: signal.failedTests,
      runId: signal.runId,
    },
    // Namespaced by repo, same reasoning as handleGitSignal (directive-27).
    dedupKey: `test:${signal.repo}:${signal.branch}:${signal.runId}`,
  })

  if (deduped) return { duplicate: true, passed: signal.passed, mode, dispatched: false }
  if (signal.passed) return { duplicate: false, passed: true, mode, dispatched: false } // nothing to react on a pass

  const outcome = await onTestFailure(signal, deps)
  return { duplicate: false, passed: false, ...outcome }
}

export async function handleGitSignal(signal: GitSignal): Promise<{ duplicate: boolean; event: BionEvent }> {
  const { event, deduped } = await recordEvent({
    kind: signal.event === 'commit' ? 'git.commit' : 'git.branch',
    source: 'watcher:git',
    payload: { repo: signal.repo, branch: signal.branch, sha: signal.sha },
    // Namespaced by repo (directive-27): shas are already effectively unique across independent
    // repos, so this isn't fixing a real collision — it removes even the theoretical case and
    // makes the events table self-describing without a join back to a repo-path config.
    dedupKey: `git:${signal.event}:${signal.repo}:${signal.sha}`,
  })

  // directive-18 addendum: a commit is the closest thing Bion already observes to "Kov just did
  // a turn" — the trigger the collector was missing. Best-effort, same posture as
  // recordDesktopCostSafely: a scan failure must never affect the git-signal path. Skipped on a
  // duplicate signal (already-seen commit) so a re-run doesn't do redundant work.
  if (!deduped && signal.event === 'commit') {
    try {
      await collectKovCost()
    } catch (err) {
      console.error('[cost] kov collector scan failed (git signal unaffected):', (err as Error).message)
    }
  }

  return { duplicate: deduped, event }
}
