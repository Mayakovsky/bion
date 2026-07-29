import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  parseTaskArgv,
  parseCreateArgs,
  parseListArgs,
  formatTask,
  formatTaskList,
  createTask,
  listTasks,
} from '../src/index.js'

describe('bion task argv parsing', () => {
  it('splits positionals from --flag value pairs, and bare --flag reads as "true"', () => {
    const { positional, flags } = parseTaskArgv(['t-1', '--title', 'hello world', '--priority', '5', '--urgent'])
    expect(positional).toEqual(['t-1'])
    expect(flags).toEqual({ title: 'hello world', priority: '5', urgent: 'true' })
  })

  it('parseCreateArgs requires an id and --title, and builds CreateTaskInput correctly', () => {
    expect(() => parseCreateArgs([])).toThrow(/usage/)
    expect(() => parseCreateArgs(['t-1'])).toThrow(/--title is required/)

    const args = parseCreateArgs(['t-1', '--title', 'Do the thing', '--owner', 'kov', '--priority', '3', '--deps', 'a,b,c', '--project', 'expansion'])
    expect(args).toEqual({
      id: 't-1',
      title: 'Do the thing',
      owner: 'kov',
      priority: 3,
      dependencies: ['a', 'b', 'c'],
      project: 'expansion',
    })
  })

  it('parseCreateArgs never accepts --ratified — rejects before createTask ever sees it', () => {
    expect(() => parseCreateArgs(['t-1', '--title', 'x', '--ratified', 'true'])).toThrow(/--ratified/)
  })

  it('parseListArgs maps --ratified true/false/all/omitted to boolean|undefined', () => {
    expect(parseListArgs([]).ratified).toBeUndefined()
    expect(parseListArgs(['--ratified', 'all']).ratified).toBeUndefined()
    expect(parseListArgs(['--ratified', 'true']).ratified).toBe(true)
    expect(parseListArgs(['--ratified', 'false']).ratified).toBe(false)
    expect(parseListArgs(['--project', 'expansion', '--status', 'backlog'])).toEqual({
      project: 'expansion',
      status: 'backlog',
      ratified: undefined,
    })
  })
})

describe('bion task create (CLI layer over createTask)', () => {
  it('a parsed create command never writes ratified=true, regardless of flags supplied', async () => {
    const id = `t-cli-${randomUUID()}`
    const task = await createTask(parseCreateArgs([id, '--title', 'cli-created', '--owner', 'kov']))
    expect(task.ratified).toBe(false)
    expect(task.owner).toBe('kov')
  })

  it('formatTask/formatTaskList render the fields a human needs to see', async () => {
    const id = `t-fmt-${randomUUID()}`
    const task = await createTask({ id, title: 'formatted task', owner: 'desktop', priority: 7 })
    const line = formatTask(task)
    expect(line).toContain(id)
    expect(line).toContain('ratified=false')
    expect(line).toContain('owner=desktop')
    expect(line).toContain('prio=7')
    expect(formatTaskList([])).toBe('(no tasks match)')
    expect(formatTaskList([task])).toBe(line)
  })
})

describe('bion task list filters (listTasks)', () => {
  it('filters by project, status, and ratified independently', async () => {
    const project = `proj-${randomUUID().slice(0, 8)}`
    const other = `proj-other-${randomUUID().slice(0, 8)}`
    const a = await createTask({ id: `t-a-${randomUUID()}`, title: 'a', project, status: 'backlog' })
    const b = await createTask({ id: `t-b-${randomUUID()}`, title: 'b', project, status: 'ready' })
    await createTask({ id: `t-c-${randomUUID()}`, title: 'c', project: other, status: 'backlog' })

    const byProject = await listTasks({ project })
    expect(byProject.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())

    const byStatus = await listTasks({ project, status: 'ready' })
    expect(byStatus.map((t) => t.id)).toEqual([b.id])

    const allRatifiedFalse = await listTasks({ project, ratified: false })
    expect(allRatifiedFalse.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())

    const ratifiedTrue = await listTasks({ project, ratified: true })
    expect(ratifiedTrue).toEqual([]) // nothing in this test project has been ratified
  })

  it('no filters returns everything (bounded only by DB contents, not a hidden default)', async () => {
    const id = `t-nofilter-${randomUUID()}`
    await createTask({ id, title: 'unscoped' })
    const all = await listTasks()
    expect(all.some((t) => t.id === id)).toBe(true)
  })
})
