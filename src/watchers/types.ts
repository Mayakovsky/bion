// Normalized signals emitted by watchers. GitSignal is multi-repo (directive-27); TestSignal is
// still bion-only pending directive-27 Task 2.

export interface TestSignal {
  kind: 'test'
  branch: string
  passed: boolean
  failed: number
  total: number
  failedTests: string[]
  /** Unique per run (e.g. a timestamp or CI id) — makes the Bion event idempotent per run. */
  runId: string
}

export interface GitSignal {
  kind: 'git'
  event: 'commit' | 'branch'
  /** Short label for the watched repo (e.g. 'bion', 'grey') — never a filesystem path. Required,
   *  not optional: every call site names its repo explicitly so no reader has to guess what an
   *  absent field means (directive-27). */
  repo: string
  branch: string
  sha: string
}

export type WatchSignal = TestSignal | GitSignal
