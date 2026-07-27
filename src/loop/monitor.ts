import { recordEvent } from '../core/events.js'
import { getTask, setTaskStatus } from '../core/tasks.js'
import { notifyForces, type NotifyInput, type NotifyResult } from '../notify/ntfy.js'
import type { AgentAdapter } from '../adapters/types.js'
import type { Task } from '../core/types.js'

export type NotifyFn = (input: NotifyInput) => Promise<NotifyResult>

export interface CompletionDeps {
  /** Adapter used to queue the Desktop review packet. */
  desktop: AgentAdapter
  /** Notification transport; defaults to the real ntfy notifier (dry-run without creds). */
  notify?: NotifyFn
}

export interface CompletionOutcome {
  duplicate: boolean
  task: Task | null
  reviewPath?: string
  notified?: NotifyResult
}

function reviewPacket(task: Task): string {
  return [
    `# Review requested — task ${task.id}`,
    '',
    `Kov reports task **${task.id}** ("${task.title}") complete.`,
    '',
    'Bion has updated state to `done`. This awaits the Forces gate: review the diff, then',
    'authorize push / merge / tag / deploy. Bion never self-approves a gated action.',
    '',
  ].join('\n')
}

/**
 * State monitor — handle a task-completion signal from Kov (or, in Phase D, a watcher).
 *
 * Flow (Gate C): detect (idempotent event) → update state → ntfy Forces → queue Desktop review.
 * A duplicate signal is a pure no-op: the completion event dedups on the task id (inv 11), and
 * the outward actions (notify, review packet) are gated on that first detection so a replayed
 * signal produces no second notification and no orphan review packet.
 */
export async function reportCompletion(
  taskId: string,
  source: string,
  deps: CompletionDeps,
): Promise<CompletionOutcome> {
  // 1) detect — idempotent by task id
  const { deduped } = await recordEvent({
    kind: 'task.completed',
    source,
    payload: { taskId },
    dedupKey: `task.completed:${taskId}`,
  })
  if (deduped) {
    return { duplicate: true, task: await getTask(taskId) }
  }

  // 2) update state
  const task = (await setTaskStatus(taskId, 'done')) ?? (await getTask(taskId))
  if (!task) return { duplicate: false, task: null }

  // 3) ntfy Forces — human decision required (the review/merge gate)
  const notify = deps.notify ?? ((i: NotifyInput) => notifyForces(i))
  const notified = await notify({
    title: `Bion: task ${task.id} complete — review`,
    message: `Kov completed ${task.id} ("${task.title}"). Desktop review queued; awaiting your gate.`,
    priority: 4,
    tags: ['bion', 'review'],
  })

  // 4) queue Desktop review through Bion (routed, DB-authoritative)
  const review = await deps.desktop.dispatch({
    sender: 'bion',
    recipient: 'desktop',
    thread: task.id,
    summary: `review ${task.id}`,
    body: reviewPacket(task),
    origin: 'bion',
    type: 'review-request',
  })

  return { duplicate: false, task, reviewPath: review.path, notified }
}
