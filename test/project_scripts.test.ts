import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTask, getTask, query } from '../src/index.js'
import { runOwnerScript } from './helpers.js'

// directive-19: owner-lane scripts, tested as the real artifacts (not a TS re-implementation of
// their SQL) — round-tripped against a scratch project + tasks.
describe('scripts/create-project.sh + scripts/ratify-project.sh (owner lane)', () => {
  it('create-project.sh inserts a row the runtime role can read back', async () => {
    const id = `proj-script-${randomUUID().slice(0, 8)}`
    const out = runOwnerScript('create-project.sh', [id, '5'])
    expect(out).toContain(id)

    const row = await query<{ id: string; ordinal: number; active: boolean }>(
      `SELECT id, ordinal, active FROM projects WHERE id = $1`,
      [id],
    )
    expect(row.rows[0]).toEqual({ id, ordinal: 5, active: true })
  })

  it('create-project.sh is idempotent — re-running with a new ordinal updates it', async () => {
    const id = `proj-script-${randomUUID().slice(0, 8)}`
    runOwnerScript('create-project.sh', [id, '1'])
    runOwnerScript('create-project.sh', [id, '9'])

    const row = await query<{ ordinal: number }>(`SELECT ordinal FROM projects WHERE id = $1`, [id])
    expect(row.rows[0]!.ordinal).toBe(9)
  })

  it('ratify-project.sh batch-ratifies every unratified task in the project and leaves others alone', async () => {
    const projectId = `proj-script-${randomUUID().slice(0, 8)}`
    runOwnerScript('create-project.sh', [projectId, '1'])

    const inProject1 = await createTask({ id: `t-${randomUUID()}`, title: 'in-project a', project: projectId })
    const inProject2 = await createTask({ id: `t-${randomUUID()}`, title: 'in-project b', project: projectId })
    const outsideProject = await createTask({ id: `t-${randomUUID()}`, title: 'elsewhere' })

    expect(inProject1.ratified).toBe(false)
    expect(inProject2.ratified).toBe(false)

    const out = runOwnerScript('ratify-project.sh', [projectId])
    expect(out).toContain(inProject1.id)
    expect(out).toContain(inProject2.id)

    expect((await getTask(inProject1.id))!.ratified).toBe(true)
    expect((await getTask(inProject2.id))!.ratified).toBe(true)
    expect((await getTask(outsideProject.id))!.ratified).toBe(false) // untouched

    // idempotent: a second run ratifies nothing new (already-ratified tasks excluded by the WHERE)
    const second = runOwnerScript('ratify-project.sh', [projectId])
    expect(second).not.toContain(inProject1.id)
  })
})
