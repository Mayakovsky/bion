import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectStatus,
  formatStatus,
  createTask,
  withTransaction,
  enqueueOutbox,
  writeHeartbeat,
} from '../src/index.js'
import { ratifyAsForces, deleteTasksAsForces } from './helpers.js'

describe('bion status (E2) reports accurate live state', () => {
  it('reflects a newly ratified backlog task and a pending outbox entry', async () => {
    const before = await collectStatus()

    const taskId = `t-${randomUUID()}`
    try {
      await createTask({ id: taskId, title: 'status probe' })
      await ratifyAsForces(taskId)
      await withTransaction((c) =>
        enqueueOutbox({ kind: 'notify', dedupKey: `notify:status:${randomUUID()}`, payload: { title: 't', message: 'm', priority: 3, tags: [] } }, c),
      )

      const after = await collectStatus()
      expect(after.tasks.ratifiedBacklog).toBe(before.tasks.ratifiedBacklog + 1)
      expect(after.tasks.dispatchable).toBe(before.tasks.dispatchable + 1)
      expect(after.queue.pending).toBe(before.queue.pending + 1)
      expect(after.tasks.total).toBe(before.tasks.total + 1)
    } finally {
      await deleteTasksAsForces([taskId])
    }
  })

  it('reads daemon liveness from the heartbeat and usage from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bion-status-'))
    const hbPath = join(dir, 'heartbeat.json')
    const usagePath = join(dir, 'usage.json')
    const ts = new Date().toISOString()
    writeHeartbeat({ pid: 999, ts, tick: 42, mode: { reactive: 'shadow', auto: 'off' } }, hbPath)
    writeFileSync(usagePath, JSON.stringify({ pct: 0.5 }), 'utf8')

    const d = await collectStatus({ heartbeatPath: hbPath, usagePath })
    expect(d.daemon.alive).toBe(true)
    expect(d.daemon.heartbeat!.tick).toBe(42)
    expect(d.usage).toEqual({ pct: 0.5 })

    const text = formatStatus(d)
    expect(text).toContain('BION STATUS')
    expect(text).toContain('daemon:    ALIVE')
    expect(text).toMatch(/outbox:.*pending=/)
  })

  it('sanity: outbox done count is a number', async () => {
    const d = await collectStatus()
    expect(typeof d.queue.done).toBe('number')
  })
})
