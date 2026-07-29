import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { withTransaction } from '../db/pool.js'
import { recordEvent } from '../core/events.js'
import { getTask, setTaskStatus } from '../core/tasks.js'
import { send } from '../core/send.js'
import { enqueueOutbox, drainOutbox } from '../db/outbox.js'
import { mailboxRoot } from '../mailbox/mailbox.js'
import { pointer, serialize } from '../comms/protocol.js'
import { recordDesktopCostSafely } from '../cost/desktopCollector.js'
import type { NotifyFn, NotifyResult } from '../notify/ntfy.js'
import type { Task } from '../core/types.js'

export type { NotifyFn } from '../notify/ntfy.js'

export interface CompletionDeps {
  /** Mailbox root the Desktop review packet is routed into (defaults to cwd/.bion/mail). */
  mailRoot?: string
  /** Notification transport; defaults to the real ntfy notifier (dry-run without creds). */
  notify?: NotifyFn
}

export interface CompletionOutcome {
  duplicate: boolean
  task: Task | null
  reviewPath?: string
  notified?: NotifyResult
}

export interface StageResult {
  duplicate: boolean
  task: Task | null
  reviewPath?: string
  reviewMessageId?: string
}

interface StageTxResult extends StageResult {
  /** Internal-only: the review packet body, kept just long enough to size the post-commit cost estimate. */
  reviewBody?: string
}

// Comms Protocol v1 pointer (E4): points at the completed task + the gate; diff is the richness.
function reviewPacket(task: Task): string {
  return serialize(
    pointer('review', {
      refs: [`task:${task.id}`],
      fields: { task_id: task.id, state: 'done', gate: 'forces' },
      note: 'kov reports done; review diff, then authorize push/merge',
    }),
  )
}

/**
 * Stage a completion durably (Phase D1): in ONE transaction, record the completion event, flip the
 * task to done, and enqueue BOTH outward intents — the ntfy to Forces AND the Desktop review packet
 * (as a routed messages row + a publish-outbox entry). Nothing is sent here; the drainer/reconciler
 * performs the side effects durably: the review packet exactly-once, the notification at-least-once
 * (dup-tolerant). A crash after this commit loses nothing (closes FDQ-B7).
 */
export async function stageCompletion(
  taskId: string,
  source: string,
  opts: { mailRoot?: string } = {},
): Promise<StageResult> {
  const result = await withTransaction<StageTxResult>(async (client) => {
    const { deduped } = await recordEvent(
      { kind: 'task.completed', source, payload: { taskId }, dedupKey: `task.completed:${taskId}` },
      client,
    )
    if (deduped) return { duplicate: true, task: await getTask(taskId, client) }

    const task = (await setTaskStatus(taskId, 'done', client)) ?? (await getTask(taskId, client))
    if (!task) return { duplicate: false, task: null }

    // outward intent 1: notify Forces (human decision — the review/merge gate)
    await enqueueOutbox(
      {
        kind: 'notify',
        dedupKey: `notify:${task.id}`,
        payload: {
          title: `Bion: task ${task.id} complete — review`,
          message: `Kov completed ${task.id} ("${task.title}"). Desktop review queued; awaiting your gate.`,
          priority: 4,
          tags: ['bion', 'review'],
        },
      },
      client,
    )

    // outward intent 2: route a review packet to Desktop (row + publish intent)
    const finalPath = join(mailboxRoot(opts.mailRoot), 'desktop', 'unread', `${randomUUID()}.md`)
    const body = reviewPacket(task)
    const { message, deduped: rDup } = await send(
      { sender: 'bion', recipient: 'desktop', thread: task.id, type: 'review-request', summary: `review ${task.id}`, body, bodyPath: finalPath, origin: 'bion' },
      client,
    )
    if (!rDup) {
      await enqueueOutbox(
        { kind: 'publish', dedupKey: `publish:${message.id}`, payload: { messageId: message.id, finalPath, body } },
        client,
      )
    }
    return { duplicate: false, task, reviewPath: finalPath, reviewMessageId: message.id, reviewBody: body }
  })

  // Best-effort, OUTSIDE the transaction: a cost-estimate failure must never re-open or block a
  // completion that already committed (directive-18, same non-blocking rule as routePacket).
  if (!result.duplicate && result.reviewMessageId) {
    await recordDesktopCostSafely({
      body: result.reviewBody!,
      sender: 'bion',
      recipient: 'desktop',
      triggerClass: 'review-request',
      messageId: result.reviewMessageId,
    })
  }

  return result
}

/**
 * State monitor — handle a task-completion signal. Stage the intents transactionally, then drain.
 * A duplicate signal is a pure no-op (the completion event dedups on the task id). Because the
 * outward actions are durable intents, a crash between commit and drain is recovered by the
 * reconciler — the review is published exactly-once and the notification sent at-least-once (Gate D1).
 */
export async function reportCompletion(
  taskId: string,
  source: string,
  deps: CompletionDeps,
): Promise<CompletionOutcome> {
  const staged = await stageCompletion(taskId, source, { mailRoot: deps.mailRoot })
  if (staged.duplicate) return { duplicate: true, task: staged.task }

  const drain = await drainOutbox({ notify: deps.notify })
  const mine = drain.notifications.find((n) => n.dedupKey === `notify:${taskId}`)
  return { duplicate: false, task: staged.task, reviewPath: staged.reviewPath, notified: mine?.result }
}
