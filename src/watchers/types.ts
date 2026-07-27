// Normalized signals emitted by watchers over the bion repo (dogfood). Extensible to other repos.

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
  branch: string
  sha: string
}

export type WatchSignal = TestSignal | GitSignal
