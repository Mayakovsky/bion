import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

export interface StagedPacket {
  /** Written, not yet visible in unread/. */
  tmpPath: string
  /** Where publishStaged() will atomically place it. */
  finalPath: string
  filename: string
}

/**
 * Stage a packet to .tmp/ WITHOUT publishing it. The payload exists on disk but is invisible to
 * readers scanning unread/. Callers publish it (publishStaged) only AFTER the authoritative DB row
 * is committed — so a packet is never observable in unread/ before its row exists (FDQ-B8).
 */
export function stagePacket(
  recipient: string,
  content: string,
  opts: { root?: string; filename?: string } = {},
): StagedPacket {
  const root = opts.root ?? ''
  ensureDirs(root, recipient)
  const filename = opts.filename ?? `${randomUUID()}.md`
  const tmpPath = join(mailboxRoot(root), recipient, '.tmp', `${randomUUID()}.tmp`)
  const finalPath = join(boxDir(root, recipient, 'unread'), filename)
  writeFileSync(tmpPath, content, 'utf8')
  return { tmpPath, finalPath, filename }
}

/** Atomically publish a staged packet into unread/ (the visible point). Returns its final path. */
export function publishStaged(staged: StagedPacket): string {
  renameSync(staged.tmpPath, staged.finalPath)
  return staged.finalPath
}

/** Drop a staged packet without publishing (e.g. the row was a dedup no-op, or send() failed). */
export function discardStaged(staged: StagedPacket): void {
  if (existsSync(staged.tmpPath)) rmSync(staged.tmpPath)
}

/** Atomically write a packet straight into unread/ (stage + publish). Returns its final path. */
export function writePacket(
  recipient: string,
  content: string,
  opts: { root?: string; filename?: string } = {},
): WrittenPacket {
  const staged = stagePacket(recipient, content, opts)
  const path = publishStaged(staged)
  return { path, filename: staged.filename }
}

/**
 * Atomically publish `body` to an absolute `finalPath` (…/<recipient>/unread/<file>). Used by the
 * outbox drainer/reconciler to materialize a packet from its persisted payload — decoupled from
 * recipient/root because the path already encodes them. Idempotent when guarded by an existsSync
 * check upstream (the drainer skips if the file is already present or the message is consumed).
 */
export function publishBodyToPath(finalPath: string, body: string): string {
  const unreadDir = dirname(finalPath) // …/<recipient>/unread
  const tmpDir = join(dirname(unreadDir), '.tmp')
  mkdirSync(unreadDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  const tmp = join(tmpDir, `${randomUUID()}.tmp`)
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, finalPath)
  return finalPath
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
