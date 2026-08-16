import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { withTransaction } from '../db/pool.js'
import { enqueueOutbox, notifyDurably } from '../db/outbox.js'
import { mailboxRoot } from '../mailbox/mailbox.js'
import { send } from './send.js'
import { recordDesktopCostSafely } from '../cost/desktopCollector.js'
import { isPointer, parse } from '../comms/protocol.js'
import type { NotifyFn } from '../notify/ntfy.js'
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
  /** Notify dependency override — test isolation only; defaults to the real ntfy sender. */
  notify?: NotifyFn
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
  const result = await withTransaction(async (client) => {
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

  // Best-effort, OUTSIDE the transaction and on the runtime pool, not the checked-out client:
  // a cost-estimate failure must never roll back or block the actual dispatch (directive-18).
  if (!result.deduped) {
    await recordDesktopCostSafely({
      body: input.body,
      sender: input.sender,
      recipient: input.recipient,
      triggerClass: input.type ?? 'packet',
      messageId: result.message.id,
    })
  }

  // directive-71 Task 2: intent=escalate must reach Forces immediately, not wait for a mailbox
  // check. Wired here (routePacket), not BaseAdapter.dispatch(), because this is the ONE funnel
  // every route commits through — both adapter dispatch() and reactive.ts's direct routePacket()
  // calls — so an escalate packet can never bypass the notify regardless of caller. Deduped on the
  // message id (notifyDurably's own dedup key), so a retry/reconcile of the same packet (deduped
  // === true, same message.id) can't double-fire it. Non-fatal: the notify-intent is already
  // durably enqueued inside notifyDurably's own transaction before it drains, so a send failure
  // here just leaves it 'pending' for the next reconcile() — it never blocks the packet dispatch.
  if (isPointer(input.body)) {
    const msg = parse(input.body)
    if (msg.intent === 'escalate') {
      const fieldsLine = Object.entries(msg.fields).map(([k, v]) => `${k}=${v}`).join(' ')
      await notifyDurably(
        {
          title: `Bion ESCALATE: ${input.summary || msg.fields.topic || 'standing gate crossed'}`,
          message: [msg.note, fieldsLine].filter(Boolean).join(' — ') || `escalate packet ${result.message.id}, no detail fields`,
          priority: 5,
          tags: ['bion', 'escalate'],
        },
        `notify:escalate:${result.message.id}`,
        { notify: input.notify },
      ).catch((err) =>
        console.error('[routing] escalate notify failed (non-fatal, durable, will retry on reconcile):', (err as Error).message),
      )
    }
  }

  return result
}
