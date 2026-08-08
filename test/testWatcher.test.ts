import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pollTests,
  createTestPollState,
  RESULT_FILENAME,
  KovAdapter,
  query,
  type RepoRef,
  type ReactiveDeps,
} from '../src/index.js'

// Direct pollTests() coverage (directive-27 Task 2) — this watcher didn't exist for either repo
// before this directive. Throwaway local git repos (pollTests reads branch via readGitHead, so
// each fixture needs to actually be a git repo), real vitest-shaped JSON, not real bion/grey.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function freshRepo(): string {
  const dir = join(tmpdir(), `bion-testwatcher-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@bion.local'])
  git(dir, ['config', 'user.name', 'bion-test'])
  writeFileSync(join(dir, 'f.txt'), 'x')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  return dir
}

function vitestJson(opts: { total: number; failed: number; failedNames?: string[] }): string {
  return JSON.stringify({
    numTotalTests: opts.total,
    numFailedTests: opts.failed,
    testResults: opts.failed
      ? [{ name: 'x.test.ts', assertionResults: (opts.failedNames ?? ['x']).map((n) => ({ fullName: n, status: 'failed' })) }]
      : [],
  })
}

/** Write a result file, then nudge its mtime forward — Windows FS mtime resolution can be coarse
 *  enough that two writes within the same tick land on an identical mtime, which would make a
 *  genuinely-new run look unchanged to pollTests's mtime-diff check. */
function writeResult(dir: string, content: string, bumpMs = 0): string {
  const path = join(dir, RESULT_FILENAME)
  writeFileSync(path, content)
  if (bumpMs) {
    const now = new Date(Date.now() + bumpMs)
    utimesSync(path, now, now)
  }
  return path
}

function testDeps(root: string): ReactiveDeps {
  return { kov: new KovAdapter({ mailRoot: root }), mailRoot: root, mode: 'off', notify: async () => ({ sent: true, dryRun: true }) }
}

async function eventCount(dedupKey: string): Promise<number> {
  const res = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE dedup_key = $1`, [dedupKey])
  return Number(res.rows[0]!.n)
}

describe('pollTests — file-drop + poll', () => {
  it('emits a test.passed event on first poll, nothing on an unchanged re-poll', async () => {
    const dir = freshRepo()
    const name = `solo-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createTestPollState()
    const repos: RepoRef[] = [{ name, path: dir }]

    writeResult(dir, vitestJson({ total: 3, failed: 0 }))
    await pollTests(repos, state, testDeps(root))

    const rows = await query<{ dedup_key: string }>(
      `SELECT dedup_key FROM events WHERE kind = 'test.passed' AND payload->>'repo' = $1 ORDER BY ts DESC LIMIT 1`,
      [name],
    )
    expect(rows.rows).toHaveLength(1)
    const key = rows.rows[0]!.dedup_key
    expect(await eventCount(key)).toBe(1)

    await pollTests(repos, state, testDeps(root)) // file unchanged — no new event
    expect(await eventCount(key)).toBe(1)
  })

  it('a rewritten result file (new mtime) produces a fresh signal', async () => {
    const dir = freshRepo()
    const name = `rerun-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createTestPollState()
    const repos: RepoRef[] = [{ name, path: dir }]

    writeResult(dir, vitestJson({ total: 1, failed: 0 }))
    await pollTests(repos, state, testDeps(root))
    const first = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = 'test.passed' AND payload->>'repo' = $1`, [name])

    writeResult(dir, vitestJson({ total: 1, failed: 1, failedNames: ['y'] }), 1000)
    await pollTests(repos, state, testDeps(root))
    const second = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = 'test.failed' AND payload->>'repo' = $1`, [name])

    expect(Number(first.rows[0]!.n)).toBe(1)
    expect(Number(second.rows[0]!.n)).toBe(1)
  })

  it('discovers a per-package result file nested under the repo root (turborepo shape)', async () => {
    const dir = freshRepo()
    const pkgDir = join(dir, 'packages', 'some-pkg')
    mkdirSync(pkgDir, { recursive: true })
    const name = `nested-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createTestPollState()
    const repos: RepoRef[] = [{ name, path: dir }]

    writeResult(pkgDir, vitestJson({ total: 2, failed: 0 }))
    await pollTests(repos, state, testDeps(root))

    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = 'test.passed' AND payload->>'repo' = $1`, [name])
    expect(Number(rows.rows[0]!.n)).toBe(1)
  })

  it('skips node_modules — a result file dropped there is never discovered', async () => {
    const dir = freshRepo()
    const nmDir = join(dir, 'node_modules', 'some-dep')
    mkdirSync(nmDir, { recursive: true })
    const name = `skip-nm-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createTestPollState()
    const repos: RepoRef[] = [{ name, path: dir }]

    writeResult(nmDir, vitestJson({ total: 1, failed: 0 }))
    await pollTests(repos, state, testDeps(root))

    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = 'test.passed' AND payload->>'repo' = $1`, [name])
    expect(Number(rows.rows[0]!.n)).toBe(0)
  })

  it("one repo's failure (bad path) does not block another repo's poll", async () => {
    const good = freshRepo()
    const badPath = join(tmpdir(), `bion-testwatcher-missing-${randomUUID()}`) // never created
    const goodName = `iso-good-${randomUUID()}`
    const badName = `iso-bad-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createTestPollState()
    const repos: RepoRef[] = [{ name: badName, path: badPath }, { name: goodName, path: good }]

    writeResult(good, vitestJson({ total: 1, failed: 0 }))
    await expect(pollTests(repos, state, testDeps(root))).resolves.toBeUndefined()

    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = 'test.passed' AND payload->>'repo' = $1`, [goodName])
    expect(Number(rows.rows[0]!.n)).toBe(1)
  })
})

describe('pollTests dedup key is namespaced by repo', () => {
  it('the same branch+runId shape in two different repos records two distinct events', async () => {
    const dirX = freshRepo()
    const dirY = freshRepo()
    const repoX = `dedup-x-${randomUUID()}`
    const repoY = `dedup-y-${randomUUID()}`
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const state = createTestPollState()
    const repos: RepoRef[] = [{ name: repoX, path: dirX }, { name: repoY, path: dirY }]

    const body = vitestJson({ total: 1, failed: 0 })
    writeResult(dirX, body)
    writeResult(dirY, body)
    await pollTests(repos, state, testDeps(root))

    const x = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = 'test.passed' AND payload->>'repo' = $1`, [repoX])
    const y = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE kind = 'test.passed' AND payload->>'repo' = $1`, [repoY])
    expect(Number(x.rows[0]!.n)).toBe(1)
    expect(Number(y.rows[0]!.n)).toBe(1)
  })
})
