import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RepoRef } from './gitWatcher.js'
import type { TestSignal } from './types.js'
import { handleTestSignal } from './handler.js'
import type { ReactiveDeps } from '../loop/reactive.js'

// GitHub Actions CI watcher (directive-128) — closes the gap D-125's Task 3 found: real CI
// failures (the 8/17 test/env.test.ts ones) were structurally invisible, since testWatcher.ts
// only ever watches the local filesystem. Polling, not a webhook (design spec §3.2 — Bion is
// "closer to a scheduler than a participant"; every existing watcher is pull-based; a webhook
// would mean a new exposed network endpoint this project has never needed anywhere else).
// Reuses the existing pipeline rather than building a parallel one: normalizes a GH Actions run
// into the same TestSignal shape testWatcher.ts produces, and runs it through the same
// handleTestSignal() (source='watcher:ci', dedup-namespaced separately from local runs).

const execFileAsync = promisify(execFile)

/** The one step name both bion's and grey's CI workflows use for the real test command — both
 *  are bare `- run: pnpm test` with no custom `name:`, so GitHub always labels the step
 *  "Run pnpm test". Matched exactly; a workflow that ever renames this step needs this updated. */
const TEST_STEP_NAME = 'Run pnpm test'

/** How many of a repo's most recent completed runs to check each poll. Bounded, not exhaustive —
 *  recordEvent's own dedup_key makes re-checking an already-seen run a real no-op, so this only
 *  needs to comfortably cover "since the last poll", not the repo's full history. */
const RUN_LIST_LIMIT = 10

export interface CIPollState {
  /** repo name -> last real poll time (ms epoch). Rate-limits API calls per repo — Actions runs
   *  aren't as frequent as local test runs, so polling every daemon tick (45s) would hammer the
   *  API for no real gain. */
  lastPolledAt: Map<string, number>
}

export function createCIPollState(): CIPollState {
  return { lastPolledAt: new Map() }
}

export interface GhRun {
  databaseId: number
  conclusion: string
  status: string
  headBranch: string
}

interface GhJob {
  name: string
  conclusion: string
  steps: { name: string; conclusion: string }[]
}

/** Resolve a repo's real `owner/repo` GitHub slug from its actual `origin` remote — no hardcoded
 *  repo list, so a newly auto-discovered repo (discovery.ts, directive-68) is covered for free.
 *  Returns null for a non-GitHub or missing remote (nothing to poll, not an error). */
export async function resolveGhSlug(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'])
    const m = stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/)
    return m ? `${m[1]}/${m[2]}` : null
  } catch {
    return null
  }
}

export async function fetchRecentRuns(ghSlug: string): Promise<GhRun[]> {
  const { stdout } = await execFileAsync('gh', [
    'run',
    'list',
    '--repo',
    ghSlug,
    '--limit',
    String(RUN_LIST_LIMIT),
    '--json',
    'databaseId,conclusion,status,headBranch',
  ])
  return JSON.parse(stdout) as GhRun[]
}

/** The real test step's conclusion within a run, wherever it lives among the run's jobs — null if
 *  no job in this run has a step named TEST_STEP_NAME at all (e.g. grey's codegen-drift/build
 *  jobs, which legitimately never run tests; not every CI run is test-relevant). */
export async function fetchTestStepConclusion(ghSlug: string, runId: number): Promise<string | null> {
  const { stdout } = await execFileAsync('gh', ['run', 'view', String(runId), '--repo', ghSlug, '--json', 'jobs'])
  const { jobs } = JSON.parse(stdout) as { jobs: GhJob[] }
  for (const job of jobs) {
    const step = job.steps.find((s) => s.name === TEST_STEP_NAME)
    if (step) return step.conclusion
  }
  return null
}

const ANSI_RE = /\x1b\[[0-9;]*m/g

// `gh run view --log-failed` prefixes every real line with `<job>\t<step>\t<ISO-8601 timestamp>Z `
// (e.g. `test\tRun pnpm test\t2026-08-17T02:26:44.939Z `) — stripped before matching so the
// per-line FAIL/Tests-summary regexes see vitest's own text, not gh's wrapper around it.
const GH_LOG_LINE_PREFIX_RE = /^.*?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/

/** Best-effort parse of vitest's default-reporter text out of a real `gh run view --log-failed`
 *  transcript. Fragile by nature (depends on vitest's own text format, not a stable contract) —
 *  explicitly named as such rather than silently trusted. Falls back to a real, honest "failed,
 *  count unknown" rather than fabricating a specific number when the text doesn't match. */
export function parseVitestFailedLog(raw: string): { failed: number; total: number; failedTests: string[] } {
  const lines = raw.split(/\r?\n/).map((l) => l.replace(ANSI_RE, '').replace(GH_LOG_LINE_PREFIX_RE, ''))
  const text = lines.join('\n')
  const summary = text.match(/Tests\s+(\d+)\s+failed(?:\s*\|\s*\d+\s+skipped)?\s*\|\s*\d+\s+passed\s+\((\d+)\)/)
  const failed = summary ? Number(summary[1]) : 0
  const total = summary ? Number(summary[2]) : 0
  const failedTests = lines
    .filter((l) => /^\s*FAIL\s+/.test(l))
    .map((l) => l.replace(/^\s*FAIL\s+/, '').trim())
  return { failed, total, failedTests }
}

export async function fetchFailedLog(ghSlug: string, runId: number): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['run', 'view', String(runId), '--repo', ghSlug, '--log-failed'])
  return stdout
}

export interface CIPollConfig {
  /** Minimum real time between polls of the same repo. Default 5 minutes. */
  pollIntervalMs?: number
  /** Injectable overrides for the real gh-CLI-backed fetchers (tests only — production always
   *  uses the real defaults). Lets pollCI's own control flow (rate-limiting, per-repo isolation,
   *  non-test-job filtering, dedup namespacing) be verified offline and deterministically,
   *  without depending on network access or a real GitHub token being present. */
  resolveGhSlugFn?: typeof resolveGhSlug
  fetchRecentRunsFn?: typeof fetchRecentRuns
  fetchTestStepConclusionFn?: typeof fetchTestStepConclusion
  fetchFailedLogFn?: typeof fetchFailedLog
}

/**
 * Poll each watched repo's recent completed GitHub Actions runs; for any whose real test step
 * (TEST_STEP_NAME) concluded success/failure, emit the same TestSignal shape testWatcher.ts
 * produces and run it through handleTestSignal (source='watcher:ci'). One repo's failure (no
 * GitHub remote, gh unauthenticated, API error) is isolated, same posture as pollGit/pollTests.
 */
export async function pollCI(
  repos: RepoRef[],
  state: CIPollState,
  deps: ReactiveDeps,
  cfg: CIPollConfig = {},
): Promise<void> {
  const intervalMs = cfg.pollIntervalMs ?? 5 * 60_000
  const resolveSlug = cfg.resolveGhSlugFn ?? resolveGhSlug
  const getRecentRuns = cfg.fetchRecentRunsFn ?? fetchRecentRuns
  const getTestStepConclusion = cfg.fetchTestStepConclusionFn ?? fetchTestStepConclusion
  const getFailedLog = cfg.fetchFailedLogFn ?? fetchFailedLog
  const now = Date.now()
  for (const repo of repos) {
    const last = state.lastPolledAt.get(repo.name) ?? 0
    if (now - last < intervalMs) continue
    state.lastPolledAt.set(repo.name, now)
    try {
      const slug = await resolveSlug(repo.path)
      if (!slug) continue // no GitHub remote — nothing to poll for this repo
      const runs = await getRecentRuns(slug)
      for (const run of runs) {
        if (run.status !== 'completed') continue
        if (run.conclusion !== 'success' && run.conclusion !== 'failure') continue
        try {
          const stepConclusion = await getTestStepConclusion(slug, run.databaseId)
          if (stepConclusion !== 'success' && stepConclusion !== 'failure') continue

          const passed = stepConclusion === 'success'
          const counts = passed
            ? { failed: 0, total: 0, failedTests: [] as string[] }
            : parseVitestFailedLog(await getFailedLog(slug, run.databaseId))

          const signal: TestSignal = {
            kind: 'test',
            repo: repo.name,
            branch: run.headBranch,
            passed,
            failed: counts.failed,
            total: counts.total,
            failedTests: counts.failedTests,
            runId: String(run.databaseId),
          }
          await handleTestSignal(signal, deps, { source: 'watcher:ci', dedupPrefix: 'ci' })
        } catch {
          /* one bad run's job/step/log fetch shouldn't block the others */
        }
      }
    } catch {
      /* one repo's CI unreachable (no remote, gh not authenticated, API/network error) — isolated,
         retried next interval, same posture as pollGit/pollTests. */
    }
  }
}
