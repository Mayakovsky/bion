import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Disk mailbox: .bion/mail/<recipient>/{unread,read,flagged}/ — append-only markdown packets.
// Writes are atomic: staged in .tmp/ then renamed into unread/ (rename is atomic on one volume),
// so a reader never observes a partial packet (spec §5, Gate B).

export type Box = 'unread' | 'read' | 'flagged'

export function mailboxRoot(root?: string): string {
  return root ?? process.env.BION_MAIL_ROOT ?? join(process.cwd(), '.bion', 'mail')
}

function boxDir(root: string, recipient: string, box: Box): string {
  return join(mailboxRoot(root), recipient, box)
}

function ensureDirs(root: string, recipient: string): void {
  for (const d of ['unread', 'read', 'flagged', '.tmp'] as const) {
    mkdirSync(join(mailboxRoot(root), recipient, d), { recursive: true })
  }
}

export interface WrittenPacket {
  path: string
  filename: string
}

/** Atomically write a packet into the recipient's unread/ box. Returns its final path. */
export function writePacket(
  recipient: string,
  content: string,
  opts: { root?: string; filename?: string } = {},
): WrittenPacket {
  const root = opts.root ?? ''
  ensureDirs(root, recipient)
  const filename = opts.filename ?? `${randomUUID()}.md`
  const tmpPath = join(mailboxRoot(root), recipient, '.tmp', `${randomUUID()}.tmp`)
  const finalPath = join(boxDir(root, recipient, 'unread'), filename)
  writeFileSync(tmpPath, content, 'utf8')
  renameSync(tmpPath, finalPath) // atomic publish
  return { path: finalPath, filename }
}

export function listBox(recipient: string, box: Box, root?: string): string[] {
  const dir = boxDir(root ?? '', recipient, box)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f))
}

export function readPacket(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Move a packet from unread/ into read/ or flagged/ (atomic rename). Returns the new path. */
export function movePacket(
  recipient: string,
  path: string,
  to: Exclude<Box, 'unread'>,
  root?: string,
): string {
  ensureDirs(root ?? '', recipient)
  const base = path.split(/[\\/]/).pop()!
  const dest = join(boxDir(root ?? '', recipient, to), base)
  renameSync(path, dest)
  return dest
}
