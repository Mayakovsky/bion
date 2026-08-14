import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleGitSignal, commitSignal, branchSignal, query } from '../src/index.js'

const freshRoot = () => join(tmpdir(), `bion-kov-cost-git-${randomUUID()}`)

/** Point BION_CLAUDE_PROJECTS_ROOT at `root` for the duration of `fn`, then restore it. */
async function withProjectsRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BION_CLAUDE_PROJECTS_ROOT
  process.env.BION_CLAUDE_PROJECTS_ROOT = root
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.BION_CLAUDE_PROJECTS_ROOT
    else process.env.BION_CLAUDE_PROJECTS_ROOT = prev
  }
}

function usageLine(requestId: string): string {
  return JSON.stringify({
    requestId,
    message: {
      id: `msg_${requestId}`,
      model: 'claude-sonnet-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    session_id: `sess-${randomUUID()}`,
    timestamp: new Date().toISOString(),
  })
}

// directive-18 addendum: collectKovCost() was correct but never called from anywhere live.
// A commit signal is the wired-in trigger.
describe('git commit signal triggers the kov cost collector (directive-18 addendum)', () => {
  it('a fresh commit signal scans Claude Code logs and records real cost.kov events', async () => {
    const root = freshRoot()
    const projDir = join(root, `proj-${randomUUID().slice(0, 8)}`)
    mkdirSync(projDir, { recursive: true })
    const reqId = `req-${randomUUID()}`
    writeFileSync(join(projDir, `${randomUUID()}.jsonl`), usageLine(reqId) + '\n')

    await withProjectsRoot(root, () => handleGitSignal(commitSignal('bion', 'main', `sha-${randomUUID()}`)))

    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE dedup_key = $1`, [
      `cost.kov:${reqId}`,
    ])
    expect(rows.rows[0]!.n).toBe('1')
  })

  it('a duplicate commit signal is a no-op (skips the scan, still doesn\'t throw)', async () => {
    const sha = `sha-${randomUUID()}`
    await withProjectsRoot(join(tmpdir(), `bion-kov-cost-missing-${randomUUID()}`), async () => {
      const first = await handleGitSignal(commitSignal('bion', 'main', sha))
      expect(first.duplicate).toBe(false)
      const second = await handleGitSignal(commitSignal('bion', 'main', sha))
      expect(second.duplicate).toBe(true)
    })
  })

  it('a branch signal does not trigger a scan (commit-only, per the addendum)', async () => {
    const root = freshRoot()
    const projDir = join(root, `proj-${randomUUID().slice(0, 8)}`)
    mkdirSync(projDir, { recursive: true })
    const reqId = `req-${randomUUID()}`
    writeFileSync(join(projDir, `${randomUUID()}.jsonl`), usageLine(reqId) + '\n')

    await withProjectsRoot(root, () => handleGitSignal(branchSignal('bion', 'main', `sha-${randomUUID()}`)))

    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE dedup_key = $1`, [
      `cost.kov:${reqId}`,
    ])
    expect(rows.rows[0]!.n).toBe('0')
  })

  it('a scan failure never blocks or throws through the git-signal path', async () => {
    const root = freshRoot()
    mkdirSync(root, { recursive: true })
    // Point the collector's "directory" at a plain file, so its readdirSync throws ENOTDIR.
    const notADir = join(root, 'not-a-dir')
    writeFileSync(notADir, 'x')

    await withProjectsRoot(notADir, async () => {
      const sha = `sha-${randomUUID()}`
      await expect(handleGitSignal(commitSignal('bion', 'main', sha))).resolves.toMatchObject({ duplicate: false })
    })
  })
})
