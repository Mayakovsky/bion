import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, setTaskStatus, selectDispatchable, dispatchNext, KovAdapter } from '../src/index.js'
import { ratifyAsForces, deleteTasksAsForces } from './helpers.js'

describe('dispatcher respects the ratified envelope + DAG deps (FDQ-B3 / inv 14)', () => {
  it('selects ratified tasks and never unratified ones', async () => {
    const ratified = `t-${randomUUID()}`
    const unratified = `t-${randomUUID()}`
    try {
      await createTask({ id: ratified, title: 'ratified work' })
      await createTask({ id: unratified, title: 'not ratified' })
      await ratifyAsForces(ratified)

      const ids = (await selectDispatchable()).map((t) => t.id)
      expect(ids).toContain(ratified)
      expect(ids).not.toContain(unratified)
    } finally {
      await deleteTasksAsForces([ratified, unratified])
    }
  })

  it('withholds a ratified task until its dependencies are done', async () => {
    const dep = `t-${randomUUID()}`
    const work = `t-${randomUUID()}`
    try {
      await createTask({ id: dep, title: 'prerequisite' })
      await createTask({ id: work, title: 'dependent', dependencies: [dep] })
      await ratifyAsForces(work)

      expect((await selectDispatchable()).map((t) => t.id)).not.toContain(work)
      await setTaskStatus(dep, 'done')
      expect((await selectDispatchable()).map((t) => t.id)).toContain(work)
    } finally {
      await deleteTasksAsForces([dep, work])
    }
  })

  it('dispatchNext marks the task in_progress and routes a packet; re-call does not re-dispatch it', async () => {
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const kov = new KovAdapter({ mailRoot: root })
    const hot = `t-${randomUUID()}`
    try {
      await createTask({ id: hot, title: 'top priority', priority: 1_000_000 })
      await ratifyAsForces(hot)

      const out = await dispatchNext(kov)
      expect(out).not.toBeNull()
      expect(out!.task.id).toBe(hot) // highest priority in the ratified backlog
      expect(out!.task.status).toBe('in_progress')
      expect(out!.dispatch.path.replace(/\\/g, '/')).toContain('/kov/unread/')

      // now in_progress => excluded from selection => a second dispatch won't pick it again
      expect((await selectDispatchable()).map((t) => t.id)).not.toContain(hot)
    } finally {
      await deleteTasksAsForces([hot])
    }
  })
})
