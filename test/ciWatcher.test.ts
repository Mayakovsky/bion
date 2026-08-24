import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pollCI,
  createCIPollState,
  resolveGhSlug,
  parseVitestFailedLog,
  KovAdapter,
  query,
  type RepoRef,
  type ReactiveDeps,
  type GhRun,
} from '../src/index.js'

// Direct pollCI coverage (directive-128). The GitHub-fetching functions are injected (fake, no
// network) so control flow — rate-limiting, per-repo isolation, non-test-job filtering, dedup
// namespacing — is verified offline and deterministically. resolveGhSlug and
// parseVitestFailedLog are real functions tested for real (local git; a captured real log
// fixture) — no network needed for either. Real end-to-end verification against the actual
// GitHub API (the two known 2026-08-17 bion failures) was run manually and is reported in
// _internal/BION-DIRECTIVE-128-STATUS.md, not baked into this always-runs suite.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function freshRepoWithRemote(remoteUrl: string | null): string {
  const dir = join(tmpdir(), `bion-ciwatcher-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  if (remoteUrl) git(dir, ['remote', 'add', 'origin', remoteUrl])
  return dir
}

function testDeps(root: string): ReactiveDeps {
  return { kov: new KovAdapter({ mailRoot: root }), mailRoot: root, mode: 'off', notify: async () => ({ sent: true, dryRun: true }) }
}

async function eventCount(kind: string, repo: string): Promise<number> {
  const res = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = $1 AND payload->>'repo' = $2`, [kind, repo])
  return Number(res.rows[0]!.n)
}

// Real transcript, captured 2026-08-23 from `gh run view 31987960402 --log-failed` against the
// real bion repo's actual 2026-08-17 CI failure (D-125's Task 3 fixture) — not synthesized.
const REAL_LOG_FAILED_FIXTURE = `test\tRun pnpm test\t2026-08-17T02:26:44.8463464Z \x1b[31m❯\x1b[39m test/env.test.ts \x1b[2m(\x1b[22m\x1b[2m2 tests\x1b[22m\x1b[2m | \x1b[22m\x1b[31m1 failed\x1b[39m\x1b[2m)\x1b[22m\x1b[90m 6\x1b[2mms\x1b[22m\x1b[39m
test\tRun pnpm test\t2026-08-17T02:26:44.9395698Z \x1b[31m\x1b[1m\x1b[7m FAIL \x1b[27m\x1b[22m\x1b[39m test/env.test.ts\x1b[2m > \x1b[22menv loading is cwd-independent (directive-11)\x1b[2m > \x1b[22mresolveEnvPath points at the repo-root .env.local regardless of cwd, and both vars load
test\tRun pnpm test\t2026-08-17T02:26:44.9583414Z \x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m161 passed\x1b[39m\x1b[22m\x1b[90m (162)\x1b[39m`

describe('parseVitestFailedLog — real captured log fixture', () => {
  it('extracts the real failed/total counts and failed test name from a real gh --log-failed transcript', () => {
    const { failed, total, failedTests } = parseVitestFailedLog(REAL_LOG_FAILED_FIXTURE)
    expect(failed).toBe(1)
    expect(total).toBe(162)
    expect(failedTests).toEqual([
      'test/env.test.ts > env loading is cwd-independent (directive-11) > resolveEnvPath points at the repo-root .env.local regardless of cwd, and both vars load',
    ])
  })

  it('falls back to honest zeros rather than fabricating a count when the text does not match', () => {
    expect(parseVitestFailedLog('not a real vitest transcript')).toEqual({ failed: 0, total: 0, failedTests: [] })
  })
})

describe('resolveGhSlug — real local git, no network', () => {
  it('resolves a real https GitHub remote to owner/repo', async () => {
    const dir = freshRepoWithRemote('https://github.com/Mayakovsky/bion.git')
    expect(await resolveGhSlug(dir)).toBe('Mayakovsky/bion')
  })

  it('resolves a real ssh GitHub remote to owner/repo', async () => {
    const dir = freshRepoWithRemote('git@github.com:Mayakovsky/grey.git')
    expect(await resolveGhSlug(dir)).toBe('Mayakovsky/grey')
  })

  it('returns null for a non-GitHub remote', async () => {
    const dir = freshRepoWithRemote('https://gitlab.com/someone/somewhere.git')
    expect(await resolveGhSlug(dir)).toBeNull()
  })

  it('returns null (not a throw) when there is no origin remote at all', async () => {
    const dir = freshRepoWithRemote(null)
    expect(await resolveGhSlug(dir)).toBeNull()
  })
})

describe('pollCI — control flow, offline via injected fetchers', () => {
  it('emits test.passed for a real-shaped successful run, source watcher:ci', async () => {
    const repoName = `pollci-pass-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createCIPollState()
    const runs: GhRun[] = [{ databaseId: 111, conclusion: 'success', status: 'completed', headBranch: 'main' }]

    await pollCI([{ name: repoName, path: '/unused' }], state, testDeps(root), {
      resolveGhSlugFn: async () => 'someone/somewhere',
      fetchRecentRunsFn: async () => runs,
      fetchTestStepConclusionFn: async () => 'success',
      fetchFailedLogFn: async () => '',
    })

    expect(await eventCount('test.passed', repoName)).toBe(1)
    const rows = await query<{ source: string }>(`SELECT source FROM events WHERE kind = 'test.passed' AND payload->>'repo' = $1`, [repoName])
    expect(rows.rows[0]!.source).toBe('watcher:ci')
  })

  it('emits test.failed with real parsed counts for a failing run', async () => {
    const repoName = `pollci-fail-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createCIPollState()
    const runs: GhRun[] = [{ databaseId: 222, conclusion: 'failure', status: 'completed', headBranch: 'bion/some-branch' }]

    await pollCI([{ name: repoName, path: '/unused' }], state, testDeps(root), {
      resolveGhSlugFn: async () => 'someone/somewhere',
      fetchRecentRunsFn: async () => runs,
      fetchTestStepConclusionFn: async () => 'failure',
      fetchFailedLogFn: async () => REAL_LOG_FAILED_FIXTURE,
    })

    const rows = await query<{ payload: { failed: number; total: number; failedTests: string[]; runId: string } }>(
      `SELECT payload FROM events WHERE kind = 'test.failed' AND payload->>'repo' = $1`,
      [repoName],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.payload.failed).toBe(1)
    expect(rows.rows[0]!.payload.total).toBe(162)
    expect(rows.rows[0]!.payload.runId).toBe('222')
  })

  it('skips a run whose relevant job has no real test step (e.g. a lint/build-only run)', async () => {
    const repoName = `pollci-notest-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createCIPollState()
    const runs: GhRun[] = [{ databaseId: 333, conclusion: 'success', status: 'completed', headBranch: 'main' }]

    await pollCI([{ name: repoName, path: '/unused' }], state, testDeps(root), {
      resolveGhSlugFn: async () => 'someone/somewhere',
      fetchRecentRunsFn: async () => runs,
      fetchTestStepConclusionFn: async () => null, // no "Run pnpm test" step in this run's jobs
      fetchFailedLogFn: async () => '',
    })

    expect(await eventCount('test.passed', repoName)).toBe(0)
    expect(await eventCount('test.failed', repoName)).toBe(0)
  })

  it('skips runs that are not yet completed, or completed with a non-terminal conclusion', async () => {
    const repoName = `pollci-incomplete-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createCIPollState()
    const runs: GhRun[] = [
      { databaseId: 444, conclusion: '', status: 'in_progress', headBranch: 'main' },
      { databaseId: 445, conclusion: 'cancelled', status: 'completed', headBranch: 'main' },
    ]

    await pollCI([{ name: repoName, path: '/unused' }], state, testDeps(root), {
      resolveGhSlugFn: async () => 'someone/somewhere',
      fetchRecentRunsFn: async () => runs,
      fetchTestStepConclusionFn: async () => 'success',
      fetchFailedLogFn: async () => '',
    })

    expect(await eventCount('test.passed', repoName)).toBe(0)
  })

  it('a repo with no GitHub remote is skipped, not an error, and does not block other repos', async () => {
    const noRemoteName = `pollci-noremote-${randomUUID()}`
    const okName = `pollci-ok-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createCIPollState()
    const runs: GhRun[] = [{ databaseId: 555, conclusion: 'success', status: 'completed', headBranch: 'main' }]

    await pollCI(
      [{ name: noRemoteName, path: '/no-remote' }, { name: okName, path: '/has-remote' }],
      state,
      testDeps(root),
      {
        resolveGhSlugFn: async (path) => (path === '/has-remote' ? 'someone/somewhere' : null),
        fetchRecentRunsFn: async () => runs,
        fetchTestStepConclusionFn: async () => 'success',
        fetchFailedLogFn: async () => '',
      },
    )

    expect(await eventCount('test.passed', noRemoteName)).toBe(0)
    expect(await eventCount('test.passed', okName)).toBe(1)
  })

  it("one repo's resolver throwing does not block another repo's poll", async () => {
    const badName = `pollci-throws-${randomUUID()}`
    const okName = `pollci-ok2-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createCIPollState()
    const runs: GhRun[] = [{ databaseId: 888, conclusion: 'success', status: 'completed', headBranch: 'main' }]

    await expect(
      pollCI(
        [{ name: badName, path: '/throws' }, { name: okName, path: '/ok' }],
        state,
        testDeps(root),
        {
          resolveGhSlugFn: async (path) => {
            if (path === '/throws') throw new Error('simulated resolver failure')
            return 'someone/somewhere'
          },
          fetchRecentRunsFn: async () => runs,
          fetchTestStepConclusionFn: async () => 'success',
          fetchFailedLogFn: async () => '',
        },
      ),
    ).resolves.toBeUndefined()

    expect(await eventCount('test.passed', okName)).toBe(1)
  })

  it('rate-limits: a second poll within the interval does not re-fetch', async () => {
    const repoName = `pollci-ratelimit-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createCIPollState()
    let fetchCount = 0
    const runs: GhRun[] = [{ databaseId: 666, conclusion: 'success', status: 'completed', headBranch: 'main' }]
    const cfg = {
      pollIntervalMs: 60_000,
      resolveGhSlugFn: async () => 'someone/somewhere',
      fetchRecentRunsFn: async () => {
        fetchCount++
        return runs
      },
      fetchTestStepConclusionFn: async () => 'success',
      fetchFailedLogFn: async () => '',
    }

    await pollCI([{ name: repoName, path: '/unused' }], state, testDeps(root), cfg)
    await pollCI([{ name: repoName, path: '/unused' }], state, testDeps(root), cfg)

    expect(fetchCount).toBe(1) // second call within the interval is a no-op
    expect(await eventCount('test.passed', repoName)).toBe(1) // not double-recorded either
  })

  it('a bad run (job/log fetch throws) does not block other runs in the same poll', async () => {
    const repoName = `pollci-badrun-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createCIPollState()
    const runs: GhRun[] = [
      { databaseId: 777, conclusion: 'failure', status: 'completed', headBranch: 'main' }, // will throw
      { databaseId: 778, conclusion: 'success', status: 'completed', headBranch: 'main' },
    ]

    await pollCI([{ name: repoName, path: '/unused' }], state, testDeps(root), {
      resolveGhSlugFn: async () => 'someone/somewhere',
      fetchRecentRunsFn: async () => runs,
      fetchTestStepConclusionFn: async (_slug, runId) => {
        if (runId === 777) throw new Error('simulated API error')
        return 'success'
      },
      fetchFailedLogFn: async () => '',
    })

    expect(await eventCount('test.passed', repoName)).toBe(1)
    expect(await eventCount('test.failed', repoName)).toBe(0)
  })
})

describe('CI vs local dedup namespacing (directive-128)', () => {
  it('a CI-sourced and a local-sourced signal sharing the same repo/branch/runId string record as two distinct events', async () => {
    const repoName = `dedup-ns-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createCIPollState()
    // Deliberately adversarial: a real CI runId is a GitHub databaseId, a real local runId is
    // `<path>:<mtime>` — these would never naturally collide. Forcing an identical runId STRING
    // here specifically probes that the dedup-key namespace ('ci:' vs 'test:' prefix) is what's
    // actually preventing a collision, not coincidence.
    const collisionRunId = 999
    const runs: GhRun[] = [{ databaseId: collisionRunId, conclusion: 'success', status: 'completed', headBranch: 'main' }]

    await pollCI([{ name: repoName, path: '/unused' }], state, testDeps(root), {
      resolveGhSlugFn: async () => 'someone/somewhere',
      fetchRecentRunsFn: async () => runs,
      fetchTestStepConclusionFn: async () => 'success',
      fetchFailedLogFn: async () => '',
    })

    const { handleTestSignal } = await import('../src/index.js')
    await handleTestSignal(
      { kind: 'test', repo: repoName, branch: 'main', passed: true, failed: 0, total: 0, failedTests: [], runId: String(collisionRunId) },
      testDeps(root),
      { source: 'watcher:test', dedupPrefix: 'test' },
    )

    expect(await eventCount('test.passed', repoName)).toBe(2) // both recorded — no cross-namespace dedup collision
  })
})
