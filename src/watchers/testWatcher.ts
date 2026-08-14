import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { TestSignal } from './types.js'
import type { RepoRef } from './gitWatcher.js'
import { readGitHead } from './gitWatcher.js'
import { handleTestSignal } from './handler.js'
import type { ReactiveDeps } from '../loop/reactive.js'

// Test-output watcher: normalizes a vitest JSON reporter result into a TestSignal, then polls for
// result files the same way gitWatcher polls HEAD — file-drop + poll, not grey importing Bion
// (directive-27 Task 2). Convention: a repo's test invocation runs vitest with
// `--reporter=default --reporter=json --outputFile=.bion-test-result.json` (default reporter kept
// so humans still see normal terminal output; json is additive). grey's turborepo runs `vitest run`
// per-package (`turbo run test`, 7 packages, confirmed by reading grey/package.json + turbo.json —
// no single aggregate run exists), so the file appears once per package, not once at the repo root.
// Bion doesn't hardcode the package list — it walks the repo for the well-known filename instead,
// so a new grey package picks up watching for free.

interface VitestAssertion {
  fullName?: string
  title?: string
  status: string
}
interface VitestFileResult {
  name?: string
  assertionResults?: VitestAssertion[]
}
export interface VitestJson {
  numTotalTests?: number
  numFailedTests?: number
  numPassedTests?: number
  testResults?: VitestFileResult[]
}

export interface RunMeta {
  repo: string
  branch: string
  runId: string
}

export function parseVitestJson(raw: VitestJson, meta: RunMeta): TestSignal {
  const total = raw.numTotalTests ?? 0
  const failed = raw.numFailedTests ?? 0
  const failedTests: string[] = []
  for (const f of raw.testResults ?? []) {
    for (const a of f.assertionResults ?? []) {
      if (a.status === 'failed') failedTests.push(a.fullName ?? a.title ?? f.name ?? 'unnamed')
    }
  }
  return {
    kind: 'test',
    repo: meta.repo,
    branch: meta.branch,
    passed: failed === 0,
    failed,
    total,
    failedTests,
    runId: meta.runId,
  }
}

export function readVitestResultFile(path: string, meta: RunMeta): TestSignal {
  return parseVitestJson(JSON.parse(readFileSync(path, 'utf8')) as VitestJson, meta)
}

export const RESULT_FILENAME = '.bion-test-result.json'

// Skip anything that would make the walk slow or wander into build output / dependency trees —
// none of these can meaningfully contain a fresh RESULT_FILENAME a test run just wrote.
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', 'coverage'])

/** Find every RESULT_FILENAME under `root`, bounded depth so a misconfigured repo path can't
 *  make this walk unbounded. */
function findResultFiles(root: string, maxDepth = 6): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip, don't fail the whole walk
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && entry.name === RESULT_FILENAME) {
        out.push(join(dir, entry.name))
      }
    }
  }
  walk(root, 0)
  return out
}

/** Per-file last-seen mtime (ms), keyed by absolute path. A turbo cache HIT skips re-running
 *  vitest and leaves the file untouched — same mtime, correctly no new signal. A real re-run
 *  (cache miss) rewrites the file — new mtime, new signal. */
export type TestPollState = Map<string, number>

export function createTestPollState(): TestPollState {
  return new Map()
}

/**
 * Poll each watched repo for RESULT_FILENAME files; emit + dispatch a test signal for any whose
 * mtime moved since the last poll. One repo's failure (bad path, unreadable) is isolated, same
 * posture as pollGit. runId is `<path-relative-to-repo>:<mtimeMs>` — stable across a genuine
 * re-run of the same package's suite, and distinct across packages so two packages' result files
 * can never collide even if their mtimes happen to match.
 */
export async function pollTests(repos: RepoRef[], state: TestPollState, deps: ReactiveDeps): Promise<void> {
  for (const repo of repos) {
    try {
      const files = findResultFiles(repo.path)
      if (files.length === 0) continue
      const { branch } = readGitHead(repo.path)
      for (const file of files) {
        try {
          const mtimeMs = statSync(file).mtimeMs
          if (state.get(file) === mtimeMs) continue
          state.set(file, mtimeMs)
          const runId = `${relative(repo.path, file)}:${mtimeMs}`
          const signal = readVitestResultFile(file, { repo: repo.name, branch, runId })
          await handleTestSignal(signal, deps)
        } catch {
          /* one bad/mid-write result file shouldn't block the others */
        }
      }
    } catch {
      /* repo unreachable (bad path, not a git repo) — skip this repo only */
    }
  }
}
