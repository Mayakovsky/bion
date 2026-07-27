import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Coordinator,
  KovAdapter,
  DesktopAdapter,
  createTask,
  getTask,
  query,
  type NotifyInput,
} from '../src/index.js'
import { ratifyAsForces } from './helpers.js'

// Gate C: Kov completes a task -> Bion detects (duplicate signal = no-op) -> updates state
// -> ntfy Forces -> queues Desktop review. Hands-free UP TO the gate.
describe('event loop — dispatch → complete → notify → review, hands-free up to the Forces gate', () => {
  it('runs the full loop once and treats a duplicate completion signal as a no-op', async () => {
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const kov = new KovAdapter({ mailRoot: root })
    const desktop = new DesktopAdapter({ mailRoot: root })

    const notifications: NotifyInput[] = []
    const notify = async (i: NotifyInput) => {
      notifications.push(i)
      return { sent: true, dryRun: false, status: 200 }
    }
    const bion = new Coordinator({ kov, desktop, notify })

    // Forces ratifies a task (owner lane). Priority tops the ratified backlog for this run.
    const taskId = `t-${randomUUID()}`
    await createTask({ id: taskId, title: 'wire the adapter', priority: 2_000_000 })
    await ratifyAsForces(taskId)

    // 1) Bion dispatches it to Kov autonomously.
    const dispatched = await bion.dispatchNext()
    expect(dispatched).not.toBeNull()
    expect(dispatched!.task.id).toBe(taskId)
    expect(dispatched!.task.status).toBe('in_progress')

    // Kov wakes and receives the task packet with zero copy-paste.
    const kovInbox = await kov.pollStatus()
    expect(kovInbox.consumed).toHaveLength(1)
    expect(kovInbox.consumed[0]!.content).toContain(`Task ${taskId}`)

    // 2) Kov reports completion -> detect -> update -> notify -> queue review.
    const first = await bion.reportCompletion(taskId, 'kov')
    expect(first.duplicate).toBe(false)
    expect(first.task?.status).toBe('done')
    expect(first.reviewPath!.replace(/\\/g, '/')).toContain('/desktop/unread/')
    expect(first.notified?.sent).toBe(true)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.message).toContain(taskId)

    // Desktop review is queued through Bion and consumable (routed, DB-authoritative).
    const deskInbox = await desktop.pollStatus()
    expect(deskInbox.consumed).toHaveLength(1)
    expect(deskInbox.consumed[0]!.content).toContain('Review requested')

    // 3) Duplicate completion signal is a pure no-op: no 2nd notify, no 2nd review, still done.
    const second = await bion.reportCompletion(taskId, 'kov')
    expect(second.duplicate).toBe(true)
    expect(notifications).toHaveLength(1)
    expect((await desktop.pollStatus()).consumed).toHaveLength(0)
    expect((await getTask(taskId))!.status).toBe('done')

    // the completion event collapsed to a single row (idempotent detection)
    const ev = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM events WHERE dedup_key = $1`,
      [`task.completed:${taskId}`],
    )
    expect(ev.rows[0]!.n).toBe('1')
  })
})
