import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { withTransaction } from '../db/pool.js'
import { enqueueOutbox } from '../db/outbox.js'
import { mailboxRoot } from '../mailbox/mailbox.js'
import { send } from './send.js'
import type { Message } from './types.js'

export interface RouteInput {
  sender: string
  recipient: string
  body: string
  origin: string
  thread?: string
  type?: string
  summary?: string
  mailRoot?: string
}

export interface RouteResult {
  message: Message
  deduped: boolean
  finalPath: string
}

/**
 * Route a packet durably: commit the authoritative `messages` row AND its publish-outbox entry in
 * ONE transaction, then let the drainer materialize the file. Two guarantees fall out:
 *  - a packet is never observable in unread/ before its row exists (subsumes fix-b8 / FDQ-B8);
 *  - the body is persisted in the outbox, so a crash before publish is fully recoverable (D1).
 * This does NOT publish; callers drain (immediately in-process, or via the reconciler on restart).
 */
export async function routePacket(input: RouteInput): Promise<RouteResult> {
  const filename = `${randomUUID()}.md`
  const finalPath = join(mailboxRoot(input.mailRoot), input.recipient, 'unread', filename)
  return withTransaction(async (client) => {
    const { message, deduped } = await send(
      {
        sender: input.sender,
        recipient: input.recipient,
        thread: input.thread,
        type: input.type,
        summary: input.summary,
        body: input.body,
        bodyPath: finalPath,
        origin: input.origin,
      },
      client,
    )
    if (!deduped) {
      await enqueueOutbox(
        {
          kind: 'publish',
          dedupKey: `publish:${message.id}`,
          payload: { messageId: message.id, finalPath, body: input.body },
        },
        client,
      )
    }
    return { message, deduped, finalPath }
  })
}
