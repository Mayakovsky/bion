import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { repoPath } from '../paths.js'

// Disk mailbox: .bion/mail/<recipient>/{unread,read,flagged}/ — append-only markdown packets
// (the historical, "unscoped" shape — every packet sent before directive-146/150, and any new
// packet sent without a project). Newer packets additionally support per-project scoping:
// .bion/mail/<recipient>/<project>/{unread,read,flagged}/ (directive-146/150, FDQ-B2). Both shapes
// are read simultaneously (see listBox) — the historical ~197 packets are deliberately left in
// place, never migrated (see BION-DIRECTIVE-146-ITEM5-MAILBOX-SCOPING-PROPOSAL.md's Question 3).
//
// Writes are atomic: staged in .tmp/ then renamed into unread/ (rename is atomic on one volume),
// so a reader never observes a partial packet (spec §5, Gate B).

export type Box = 'unread' | 'read' | 'flagged'

/** The 4 reserved names directly under `<root>/<recipient>/` — never valid project names, which is
 *  what lets listBox() tell "this is an old-style flat box" apart from "this is a project dir"
 *  just by name, with no separate marker file or DB lookup needed. Exported so callers building a
 *  `project` value (e.g. mail.ts's `--project` flag) can validate against the same source of truth. */
export const RESERVED_BOX_NAMES = new Set<string>(['unread', 'read', 'flagged', '.tmp'])

/** A project name is valid mailbox-scoping input iff it isn't one of the 4 reserved box names. */
export function isValidProjectName(name: string): boolean {
  return !RESERVED_BOX_NAMES.has(name)
}

export function mailboxRoot(root?: string): string {
  // `||`, not `??`: BaseAdapter defaults its unset mailRoot to '' (the field is typed non-optional
  // string), and listBox()/boxDir() coerce a missing root to '' too — an empty string must fall
  // through to the real defaults, not be taken as "root is the cwd" (directive-71 Task 3 finding:
  // this was landing real packets in a bare ./<recipient>/unread/ instead of .bion/mail/…).
  return root || process.env.BION_MAIL_ROOT || repoPath('.bion', 'mail')
}

/** `project` omitted → the historical flat shape (`<root>/<recipient>/<box>/`); given → the
 *  per-project shape (`<root>/<recipient>/<project>/<box>/`). One function, both shapes, so every
 *  caller (ensureDirs, stagePacket, movePacket's mkdir) stays in sync automatically. */
function boxDir(root: string, recipient: string, box: Box, project?: string): string {
  return project
    ? join(mailboxRoot(root), recipient, project, box)
    : join(mailboxRoot(root), recipient, box)
}

function ensureDirs(root: string, recipient: string, project?: string): void {
  for (const d of ['unread', 'read', 'flagged', '.tmp'] as const) {
    mkdirSync(project ? join(mailboxRoot(root), recipient, project, d) : join(mailboxRoot(root), recipient, d), {
      recursive: true,
    })
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
 *
 * `opts.project` (directive-146/150): scope the write into `<recipient>/<project>/…` instead of
 * the flat `<recipient>/…`. Omitted → the historical flat shape, unchanged.
 */
export function stagePacket(
  recipient: string,
  content: string,
  opts: { root?: string; filename?: string; project?: string } = {},
): StagedPacket {
  const root = opts.root ?? ''
  ensureDirs(root, recipient, opts.project)
  const filename = opts.filename ?? `${randomUUID()}.md`
  const tmpDir = opts.project
    ? join(mailboxRoot(root), recipient, opts.project, '.tmp')
    : join(mailboxRoot(root), recipient, '.tmp')
  const tmpPath = join(tmpDir, `${randomUUID()}.tmp`)
  const finalPath = join(boxDir(root, recipient, 'unread', opts.project), filename)
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
  opts: { root?: string; filename?: string; project?: string } = {},
): WrittenPacket {
  const staged = stagePacket(recipient, content, opts)
  const path = publishStaged(staged)
  return { path, filename: staged.filename }
}

/**
 * Atomically publish `body` to an absolute `finalPath` (…/<recipient>/unread/<file> OR
 * …/<recipient>/<project>/unread/<file> — layout-agnostic, the path already encodes whichever
 * shape the caller chose when it built `finalPath`). Used by the outbox drainer/reconciler to
 * materialize a packet from its persisted payload — decoupled from recipient/root/project because
 * the path already encodes them. Idempotent when guarded by an existsSync check upstream (the
 * drainer skips if the file is already present or the message is consumed).
 */
export function publishBodyToPath(finalPath: string, body: string): string {
  const unreadDir = dirname(finalPath) // …/<recipient>/unread OR …/<recipient>/<project>/unread
  const tmpDir = join(dirname(unreadDir), '.tmp')
  mkdirSync(unreadDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  const tmp = join(tmpDir, `${randomUUID()}.tmp`)
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, finalPath)
  return finalPath
}

function listMd(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f))
}

/**
 * List every packet in `box` across BOTH mailbox shapes (directive-146/150):
 *  1. The historical flat shape, `<root>/<recipient>/<box>/` — every packet ever sent before this
 *     change, permanently, with zero data movement.
 *  2. Every per-project subdirectory, `<root>/<recipient>/<project>/<box>/` — any real project name
 *     works automatically, since RESERVED_BOX_NAMES is the only thing that distinguishes "this is
 *     a project dir" from "this is the flat box itself" (a project can never be named `unread`/
 *     `read`/`flagged`/`.tmp` — enforced at the CLI layer, see mail.ts).
 * An agent's inbox is "everything addressed to me," not "everything in one project" — pollStatus()
 * needs the union, so this returns it as one flat list, same shape callers already expect.
 */
export function listBox(recipient: string, box: Box, root?: string): string[] {
  const recipientDir = join(mailboxRoot(root ?? ''), recipient)
  const flat = listMd(join(recipientDir, box))

  if (!existsSync(recipientDir)) return flat

  const scoped = readdirSync(recipientDir)
    .filter((name) => !RESERVED_BOX_NAMES.has(name))
    .filter((name) => {
      try {
        return statSync(join(recipientDir, name)).isDirectory()
      } catch {
        return false
      }
    })
    .flatMap((project) => listMd(join(recipientDir, project, box)))

  return [...flat, ...scoped]
}

export function readPacket(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * Move a packet from unread/ into read/ or flagged/ (atomic rename). Derives the destination from
 * `path` itself — swap only its own trailing box-name segment for `to`, keep everything else
 * (recipient, and a project segment if present) exactly as-is. This is layout-agnostic by
 * construction: works identically for a flat-shape path (`…/<recipient>/unread/x.md`) and a
 * project-scoped one (`…/<recipient>/<project>/unread/x.md`) with no branching needed, and a
 * packet never crosses shapes (a flat packet stays flat, a project packet stays in its project).
 */
export function movePacket(
  recipient: string,
  path: string,
  to: Exclude<Box, 'unread'>,
  root?: string,
): string {
  const recipientDir = join(mailboxRoot(root ?? ''), recipient)
  if (!path.startsWith(recipientDir + '\\') && !path.startsWith(recipientDir + '/')) {
    throw new Error(`movePacket: path "${path}" does not belong to recipient "${recipient}"`)
  }
  const boxLevelDir = dirname(path) // …/<recipient>/unread OR …/<recipient>/<project>/unread
  const destDir = join(dirname(boxLevelDir), to)
  mkdirSync(destDir, { recursive: true })
  const base = path.split(/[\\/]/).pop()!
  const dest = join(destDir, base)
  renameSync(path, dest)
  return dest
}
