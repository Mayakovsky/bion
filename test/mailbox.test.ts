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

describe('mailbox per-project scoping, dual-shape (directive-146/150, FDQ-B2)', () => {
  it('a project-scoped write lands under <recipient>/<project>/unread/, not the flat shape', () => {
    const root = freshRoot()
    const { path } = writePacket('kov', 'scoped body', { root, project: 'grey' })
    const norm = path.replace(/\\/g, '/')
    expect(norm).toContain('/kov/grey/unread/')
    expect(readFileSync(path, 'utf8')).toBe('scoped body')
  })

  it('listBox returns both the flat-shape and every project-scoped packet together, for one recipient', () => {
    const root = freshRoot()
    writePacket('kov', 'flat-1', { root })
    writePacket('kov', 'grey-1', { root, project: 'grey' })
    writePacket('kov', 'bion-1', { root, project: 'bion' })

    const files = listBox('kov', 'unread', root)
    expect(files).toHaveLength(3)
    const bodies = new Set(files.map((f) => readFileSync(f, 'utf8')))
    expect(bodies).toEqual(new Set(['flat-1', 'grey-1', 'bion-1']))
  })

  it('movePacket relocates a project-scoped packet within its own project, never into the flat shape', () => {
    const root = freshRoot()
    const { path } = writePacket('kov', 'scoped', { root, project: 'grey' })
    const dest = movePacket('kov', path, 'read', root)
    const norm = dest.replace(/\\/g, '/')
    expect(norm).toContain('/kov/grey/read/')
    expect(existsSync(path)).toBe(false)
    // listBox for 'read' must find it back under the project, and 'unread' must be empty now.
    expect(listBox('kov', 'unread', root)).toEqual([])
    expect(listBox('kov', 'read', root).map((p) => p.replace(/\\/g, '/'))).toEqual([norm])
  })

  it('a flat-shape and a project-scoped packet coexist for the same recipient without collision', () => {
    const root = freshRoot()
    const flat = writePacket('kov', 'flat-body', { root })
    const scoped = writePacket('kov', 'scoped-body', { root, project: 'grey' })
    expect(existsSync(flat.path)).toBe(true)
    expect(existsSync(scoped.path)).toBe(true)
    expect(flat.path).not.toBe(scoped.path)

    const flatDest = movePacket('kov', flat.path, 'read', root)
    expect(flatDest.replace(/\\/g, '/')).toContain('/kov/read/')
    expect(flatDest.replace(/\\/g, '/')).not.toContain('/kov/grey/')
    // the project-scoped packet must be untouched by moving the flat one.
    expect(existsSync(scoped.path)).toBe(true)
  })

  it('movePacket rejects a path that does not belong to the given recipient (real sanity check, not silent)', () => {
    const root = freshRoot()
    const { path } = writePacket('other-agent', 'x', { root })
    expect(() => movePacket('kov', path, 'read', root)).toThrow(/does not belong to recipient/)
  })
})
