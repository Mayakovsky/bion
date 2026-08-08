// Normalized signals emitted by watchers. Both signal kinds are multi-repo (directive-27).

export interface TestSignal {
  kind: 'test'
  /** Short label for the watched repo (e.g. 'bion', 'grey') — never a filesystem path. Required,
   *  same posture as GitSignal.repo (directive-27). */
  repo: string
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
