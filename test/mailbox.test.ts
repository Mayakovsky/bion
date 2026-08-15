import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePacket, listBox, movePacket, mailboxRoot, repoPath } from '../src/index.js'
import { sha256 } from '../src/index.js'

function freshRoot(): string {
  return join(tmpdir(), `bion-mail-${randomUUID()}`)
}

describe('mailbox atomic write (Gate B: no partial reads)', () => {
  it('writes a fully-formed packet into unread/ and leaves no tmp residue', () => {
    const root = freshRoot()
    const body = `# packet ${randomUUID()}\nline2\n`
    const { path } = writePacket('kov', body, { root })

    expect(path.replace(/\\/g, '/')).toContain('/kov/unread/')
    expect(readFileSync(path, 'utf8')).toBe(body)

    // the staging dir must hold no leftover .tmp files
    const tmpDir = join(mailboxRoot(root), 'kov', '.tmp')
    const residue = existsSync(tmpDir) ? readdirSync(tmpDir) : []
    expect(residue).toEqual([])
  })

  it('concurrent writes all land intact (rename is atomic under contention)', async () => {
    const root = freshRoot()
    const bodies = Array.from({ length: 40 }, (_, i) => `packet-${i}-${randomUUID()}`)
    await Promise.all(bodies.map((b) => Promise.resolve(writePacket('kov', b, { root }))))

    const files = listBox('kov', 'unread', root)
    expect(files).toHaveLength(bodies.length)
    const seen = new Set(files.map((f) => sha256(readFileSync(f, 'utf8'))))
    for (const b of bodies) expect(seen.has(sha256(b))).toBe(true)
  })

  it('movePacket relocates unread -> read atomically', () => {
    const root = freshRoot()
    const { path } = writePacket('kov', 'x', { root })
    const dest = movePacket('kov', path, 'read', root)
    expect(existsSync(path)).toBe(false)
    expect(dest.replace(/\\/g, '/')).toContain('/kov/read/')
    expect(listBox('kov', 'unread', root)).toEqual([])
  })

  it('an empty-string root (BaseAdapter\'s unset default) falls through to the real default, not a bare relative path', () => {
    // directive-71 Task 3 finding: mailboxRoot('') used to return '' literally (?? doesn't treat
    // '' as unset), so a bare `new KovAdapter()`/`new DesktopAdapter()` landed packets in
    // ./<recipient>/unread relative to cwd instead of .bion/mail/<recipient>/unread.
    expect(mailboxRoot('')).toBe(mailboxRoot(undefined))
    expect(mailboxRoot('')).toBe(repoPath('.bion', 'mail'))
  })
})
