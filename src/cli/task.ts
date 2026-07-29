import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createTask, listTasks, type CreateTaskInput, type ListTasksFilter } from '../core/tasks.js'
import { closePool } from '../db/pool.js'
import type { Task } from '../core/types.js'

// `bion task` (directive-19) — read/write CLI on `tasks`, sibling to `bion status`/`bion cost`.
// No --ratified flag, ever: the runtime role lacks the column privilege for it (directive-01
// ruling 3) — ratification is scripts/ratify-task.sh / scripts/ratify-project.sh, owner-lane only.

export interface ParsedFlags {
  positional: string[]
  flags: Record<string, string>
}

/** Minimal argv parser: `--flag value` or bare `--flag` (value 'true'); everything else is positional. */
export function parseTaskArgv(argv: string[]): ParsedFlags {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

export function parseCreateArgs(argv: string[]): CreateTaskInput {
  const { positional, flags } = parseTaskArgv(argv)
  if ('ratified' in flags) {
    throw new Error(
      'bion task create does not accept --ratified — the runtime role lacks that column privilege; ' +
        'ratify via scripts/ratify-task.sh or scripts/ratify-project.sh (owner lane)',
    )
  }
  const id = positional[0]
  if (!id) throw new Error('usage: bion task create <id> --title <t> [--owner kov|desktop] [--priority N] [--deps id1,id2] [--project <id>]')
  if (!flags.title) throw new Error('--title is required')
  return {
    id,
    title: flags.title,
    owner: flags.owner,
    priority: flags.priority !== undefined ? Number(flags.priority) : undefined,
    dependencies: flags.deps ? flags.deps.split(',').filter(Boolean) : undefined,
    project: flags.project,
  }
}

export function parseListArgs(argv: string[]): ListTasksFilter {
  const { flags } = parseTaskArgv(argv)
  const ratified = flags.ratified === undefined || flags.ratified === 'all' ? undefined : flags.ratified === 'true'
  return {
    project: flags.project,
    status: flags.status as Task['status'] | undefined,
    ratified,
  }
}

export function formatTask(t: Task): string {
  const deps = t.dependencies.length ? t.dependencies.join(',') : '-'
  return `${t.id}  [${t.status}]  ratified=${t.ratified}  owner=${t.owner ?? '-'}  project=${t.project ?? '-'}  prio=${t.priority}  deps=${deps}  "${t.title}"`
}

export function formatTaskList(tasks: Task[]): string {
  return tasks.length ? tasks.map(formatTask).join('\n') : '(no tasks match)'
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'create') {
    const task = await createTask(parseCreateArgs(rest))
    console.log(formatTask(task))
  } else if (cmd === 'list') {
    const tasks = await listTasks(parseListArgs(rest))
    console.log(formatTaskList(tasks))
  } else {
    throw new Error('usage: bion task <create|list> ...')
  }
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('bion task failed:', err.message)
      process.exit(1)
    })
}
