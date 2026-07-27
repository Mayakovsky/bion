import { pool, type Executor } from '../db/pool.js'
import { sha256, dedupKey } from './ids.js'
import type { Message } from './types.js'

export interface SendInput {
  sender: string
  recipient: string
  /** The packet body (markdown). Its SHA-256 corroborates the on-disk file (§5). */
  body: string
  origin: string
  thread?: string
  type?: string
  summary?: string
  /** Disk path of the packet; set by the mailbox layer (Phase B). */
  bodyPath?: string
  /** Explicit dedup key; defaults to a stable hash of the routing identity + content. */
  dedupKey?: string
}

export interface SendResult {
  message: Message
  /** true when an identical dedup_key already existed — re-delivery was a no-op (inv 11). */
  deduped: boolean
}

/**
 * send(packet, recipient) — register a routed message in Bion state (the DB is the routing
 * authority, §5). Idempotent on dedup_key. In Phase A this records the row + content hash;
 * the disk mailbox write is layered on in Phase B.
 */
export async function send(input: SendInput, exec: Executor = pool()): Promise<SendResult> {
  const contentSha = sha256(input.body)
  const key =
    input.dedupKey ?? dedupKey(input.sender, input.recipient, input.thread ?? '', contentSha)

  const inserted = await exec.query<Message>(
    `INSERT INTO messages (sender, recipient, thread, type, summary, body_path, content_sha256, dedup_key, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id, ts, sender, recipient, thread, type, summary, body_path, content_sha256, dedup_key, origin`,
    [
      input.sender,
      input.recipient,
      input.thread ?? null,
      input.type ?? 'packet',
      input.summary ?? '',
      input.bodyPath ?? null,
      contentSha,
      key,
      input.origin,
    ],
  )

  if ((inserted.rowCount ?? 0) > 0) {
    return { message: inserted.rows[0]!, deduped: false }
  }

  // Duplicate: return the pre-existing row unchanged.
  const existing = await exec.query<Message>(
    `SELECT id, ts, sender, recipient, thread, type, summary, body_path, content_sha256, dedup_key, origin
     FROM messages WHERE dedup_key = $1`,
    [key],
  )
  return { message: existing.rows[0]!, deduped: true }
}
