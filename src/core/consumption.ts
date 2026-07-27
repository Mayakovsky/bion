import { query } from '../db/pool.js'
import { dedupKey } from './ids.js'
import type { Message } from './types.js'

// DB-as-routing-authority (spec §5, inv 12): an agent may act on a packet ONLY if its
// content_sha256 matches an UNCONSUMED messages row addressed to it. The mailbox is payload.

/** Find an unconsumed message for `recipient` whose content hash matches the packet. */
export async function findUnconsumedByHash(
  recipient: string,
  contentSha256: string,
): Promise<Message | null> {
  const res = await query<Message>(
    `SELECT m.id, m.ts, m.sender, m.recipient, m.thread, m.type, m.summary,
            m.body_path, m.content_sha256, m.dedup_key, m.origin
     FROM messages m
     WHERE m.recipient = $1 AND m.content_sha256 = $2
       AND NOT EXISTS (SELECT 1 FROM message_consumptions c WHERE c.message_id = m.id)
     ORDER BY m.ts
     LIMIT 1`,
    [recipient, contentSha256],
  )
  return res.rows[0] ?? null
}

/** Record consumption of a message. Idempotent (UNIQUE(message_id)); re-consume is a no-op. */
export async function consume(
  messageId: string,
  consumer: string,
): Promise<{ consumed: boolean }> {
  const res = await query<{ id: string }>(
    `INSERT INTO message_consumptions (message_id, consumer, dedup_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING id`,
    [messageId, consumer, dedupKey('consume', messageId)],
  )
  return { consumed: (res.rowCount ?? 0) > 0 }
}
