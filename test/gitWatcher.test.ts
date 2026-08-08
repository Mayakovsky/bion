import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pollGit, createGitPollState, commitSignal, handleGitSignal, readGitHead, query, type RepoRef } from '../src/index.js'

// Direct pollGit() coverage (directive-27) — pollGit previously lived unexported inside daemon.ts
// and had no direct test coverage at all (daemon.test.ts always passes watchGit: false). Throwaway
// local git repos, not real bion/grey, per the directive's own instruction.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function freshRepo(): string {
  const dir = join(tmpdir(), `bion-gitwatcher-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@bion.local'])
  git(dir, ['config', 'user.name', 'bion-test'])
  commitOnce(dir, 'initial')
  return dir
}

function commitOnce(dir: string, msg: string): string {
  writeFileSync(join(dir, `f-${randomUUID()}.txt`), randomUUID())
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', msg])
  return readGitHead(dir).sha
}

async function eventCount(dedupKey: string): Promise<number> {
  const res = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE dedup_key = $1`, [dedupKey])
  return Number(res.rows[0]!.n)
}

describe('pollGit — single repo (today\'s case, unchanged)', () => {
  it('emits one git.commit event on first poll, none on a re-poll at the same HEAD', async () => {
    const dir = freshRepo()
    const name = `solo-${randomUUID()}`
    const state = createGitPollState()
    const repos: RepoRef[] = [{ name, path: dir }]

    await pollGit(repos, state)
    const { sha } = readGitHead(dir)
    expect(await eventCount(`git:commit:${name}:${sha}`)).toBe(1)

    await pollGit(repos, state) // HEAD unchanged — no new event
    expect(await eventCount(`git:commit:${name}:${sha}`)).toBe(1)

    const sha2 = commitOnce(dir, 'second')
    await pollGit(repos, state) // HEAD moved — new event
    expect(await eventCount(`git:commit:${name}:${sha2}`)).toBe(1)
  })
})

describe('pollGit — multi-repo', () => {
  it('advances two repos independently in a single poll pass', async () => {
    const dirA = freshRepo()
    const dirB = freshRepo()
    const nameA = `multi-a-${randomUUID()}`
    const nameB = `multi-b-${randomUUID()}`
    const state = createGitPollState()
    const repos: RepoRef[] = [{ name: nameA, path: dirA }, { name: nameB, path: dirB }]

    await pollGit(repos, state)
    expect(await eventCount(`git:commit:${nameA}:${readGitHead(dirA).sha}`)).toBe(1)
    expect(await eventCount(`git:commit:${nameB}:${readGitHead(dirB).sha}`)).toBe(1)

    // advance only A — B must not get a spurious re-emission
    const shaA2 = commitOnce(dirA, 'a-second')
    await pollGit(repos, state)
    expect(await eventCount(`git:commit:${nameA}:${shaA2}`)).toBe(1)
    expect(await eventCount(`git:commit:${nameB}:${readGitHead(dirB).sha}`)).toBe(1) // still just the one from before
  })

  it('one repo\'s poll failure does not block the other repo\'s poll', async () => {
    const good = freshRepo()
    const badPath = join(tmpdir(), `bion-gitwatcher-missing-${randomUUID()}`) // never created — not a git repo
    const goodName = `iso-good-${randomUUID()}`
    const badName = `iso-bad-${randomUUID()}`
    const state = createGitPollState()
    const repos: RepoRef[] = [{ name: badName, path: badPath }, { name: goodName, path: good }]

    await expect(pollGit(repos, state)).resolves.toBeUndefined() // does not throw
    expect(await eventCount(`git:commit:${goodName}:${readGitHead(good).sha}`)).toBe(1)
  })
})

describe('handleGitSignal dedup key is namespaced by repo', () => {
  it('the same literal sha in two different repos records two distinct events, not a collapsed one', async () => {
    const sha = `sha-${randomUUID()}` // identical sha string, deliberately, across two "repos"
    const repoX = `dedup-x-${randomUUID()}`
    const repoY = `dedup-y-${randomUUID()}`

    const rx = await handleGitSignal(commitSignal(repoX, 'main', sha))
    const ry = await handleGitSignal(commitSignal(repoY, 'main', sha))
    expect(rx.duplicate).toBe(false)
    expect(ry.duplicate).toBe(false) // would be a false "duplicate" under the old global-sha dedup key

    expect(await eventCount(`git:commit:${repoX}:${sha}`)).toBe(1)
    expect(await eventCount(`git:commit:${repoY}:${sha}`)).toBe(1)

    // re-sending repoX's signal is still correctly deduped against itself
    const rxAgain = await handleGitSignal(commitSignal(repoX, 'main', sha))
    expect(rxAgain.duplicate).toBe(true)
  })
})
