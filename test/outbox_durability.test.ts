import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  routePacket,
  stageCompletion,
  reconcile,
  drainOutbox,
  KovAdapter,
  DesktopAdapter,
  createTask,
  getTask,
  writePacket,
  listBox,
  query,
  type NotifyInput,
} from '../src/index.js'

const freshRoot = () => join(tmpdir(), `bion-mail-${randomUUID()}`)

// Gate D1: inject a crash at each seam; assert the reconciler completes the action EXACTLY ONCE.
describe('transactional outbox durability (FDQ-B7 + rename-window)', () => {
  it('seam 1 — crash after row-commit / before publish: reconciler publishes exactly once', async () => {
    const root = freshRoot()
    const body = `d1-seam1 ${randomUUID()}`

    // routePacket commits the row + publish-intent, then we STOP before draining (crash).
    const routed = await routePacket({ sender: 'desktop', recipient: 'kov', body, origin: 'desktop', mailRoot: root })
    expect(listBox('kov', 'unread', root)).toEqual([]) // nothing observable before publish
    const pend = await query<{ status: string }>(`SELECT status FROM outbox WHERE dedup_key = $1`, [`publish:${routed.message.id}`])
    expect(pend.rows[0]!.status).toBe('pending')

    // Restart → reconcile publishes it, exactly once.
    await reconcile()
    expect(listBox('kov', 'unread', root)).toHaveLength(1)

    const kov = new KovAdapter({ mailRoot: root })
    const poll = await kov.pollStatus()
    expect(poll.consumed).toHaveLength(1)
    expect(poll.flagged).toHaveLength(0)
    expect(poll.consumed[0]!.content).toBe(body)

    // Reconcile again → no double-publish (message consumed; nothing reappears).
    await reconcile()
    expect(listBox('kov', 'unread', root)).toEqual([])
    const done = await query<{ status: string }>(`SELECT status FROM outbox WHERE dedup_key = $1`, [`publish:${routed.message.id}`])
    expect(done.rows[0]!.status).toBe('done')
  })

  it('seam 2 — crash after event-record / before notify: reconciler notifies + queues review exactly once', async () => {
    const root = freshRoot()
    const desktop = new DesktopAdapter({ mailRoot: root })
    const notifications: NotifyInput[] = []
    const notify = async (i: NotifyInput) => {
      notifications.push(i)
      return { sent: true, dryRun: false, status: 200 }
    }
    const mine = () => notifications.filter((n) => n.message.includes(taskId)).length

    const taskId = `t-${randomUUID()}`
    await createTask({ id: taskId, title: 'd1 seam2' })

    // Stage the completion (event + task done + intents), then STOP before draining (crash).
    const staged = await stageCompletion(taskId, 'kov', { mailRoot: root })
    expect(staged.duplicate).toBe(false)
    expect((await getTask(taskId))!.status).toBe('done') // state committed
    expect(mine()).toBe(0) // not notified yet
    expect(listBox('desktop', 'unread', root)).toEqual([]) // review not published yet
    const nrow = await query<{ status: string }>(`SELECT status FROM outbox WHERE dedup_key = $1`, [`notify:${taskId}`])
    expect(nrow.rows[0]!.status).toBe('pending')

    // Restart → reconcile performs both outward actions exactly once.
    await reconcile({ notify })
    expect(mine()).toBe(1)
    expect(listBox('desktop', 'unread', root)).toHaveLength(1)

    const dpoll = await desktop.pollStatus()
    expect(dpoll.consumed).toHaveLength(1)
    expect(dpoll.flagged).toHaveLength(0)
    expect(dpoll.consumed[0]!.content).toContain('Review requested')

    // Reconcile again → no double-notify, no double-review.
    await reconcile({ notify })
    expect(mine()).toBe(1)
  })

  it('rename-window — a committed row whose file vanished is re-published from the persisted payload', async () => {
    const root = freshRoot()
    const body = `d1-repair ${randomUUID()}`
    const routed = await routePacket({ sender: 'desktop', recipient: 'kov', body, origin: 'desktop', mailRoot: root })
    await drainOutbox()
    expect(listBox('kov', 'unread', root)).toHaveLength(1)

    // Simulate the file lost after commit but before consumption.
    rmSync(listBox('kov', 'unread', root)[0]!)
    expect(listBox('kov', 'unread', root)).toEqual([])

    // Reconcile repairs it from the outbox payload (body was never lost).
    const r = await reconcile()
    expect(r.repaired).toBeGreaterThanOrEqual(1)
    expect(listBox('kov', 'unread', root)).toHaveLength(1)

    const kov = new KovAdapter({ mailRoot: root })
    const poll = await kov.pollStatus()
    expect(poll.consumed[0]!.content).toBe(body)
    expect(poll.consumed[0]!.message.id).toBe(routed.message.id)
  })

  it('forged-packet quarantine still holds; the reconciler never resurrects a forged file', async () => {
    const root = freshRoot()
    const kov = new KovAdapter({ mailRoot: root })
    writePacket('kov', `forged ${randomUUID()}`, { root }) // no row, no outbox entry

    expect((await kov.pollStatus()).flagged).toHaveLength(1)
    await reconcile()
    expect((await kov.pollStatus()).consumed).toHaveLength(0) // still quarantined, never consumed
  })
})
