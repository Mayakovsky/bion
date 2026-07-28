import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoPath } from '../paths.js'
import { query, closePool } from '../db/pool.js'
import { selectDispatchable } from '../loop/dispatcher.js'
import { reactiveMode } from '../loop/reactive.js'
import { isDaemonAlive, readHeartbeat, heartbeatPath, type Heartbeat } from '../daemon/heartbeat.js'

// `bion status` (E2) — read-only console surface for Forces, no Desktop session required.

export interface StatusData {
  daemon: { alive: boolean; heartbeat: Heartbeat | null }
  queue: { pending: number; sending: number; done: number }
  tasks: { total: number; byStatus: Record<string, number>; ratifiedBacklog: number; dispatchable: number }
  reactive: { mode: string; shadow: number; dispatch: number; halt: number }
  usage: unknown | null
}

export interface StatusOptions {
  heartbeatPath?: string
  usagePath?: string
}

export async function collectStatus(opts: StatusOptions = {}): Promise<StatusData> {
  const hbPath = opts.heartbeatPath ?? heartbeatPath()
  const usagePath = opts.usagePath ?? repoPath('.bion', 'usage.json')

  const [outbox, tasks, reactive, dispatchable] = await Promise.all([
    query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM outbox GROUP BY status`),
    query<{ status: string; n: string; ratified: boolean }>(
      `SELECT status, ratified, count(*)::text AS n FROM tasks GROUP BY status, ratified`,
    ),
    query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM events WHERE kind IN ('reactive.shadow','reactive.dispatch','reactive.halt') GROUP BY kind`,
    ),
    selectDispatchable(),
  ])

  const queue = { pending: 0, sending: 0, done: 0 }
  for (const r of outbox.rows) if (r.status in queue) (queue as Record<string, number>)[r.status] = Number(r.n)

  const byStatus: Record<string, number> = {}
  let total = 0
  let ratifiedBacklog = 0
  for (const r of tasks.rows) {
    const n = Number(r.n)
    byStatus[r.status] = (byStatus[r.status] ?? 0) + n
    total += n
    if (r.ratified && (r.status === 'backlog' || r.status === 'ready')) ratifiedBacklog += n
  }

  const rc = { shadow: 0, dispatch: 0, halt: 0 }
  for (const r of reactive.rows) {
    if (r.kind === 'reactive.shadow') rc.shadow = Number(r.n)
    if (r.kind === 'reactive.dispatch') rc.dispatch = Number(r.n)
    if (r.kind === 'reactive.halt') rc.halt = Number(r.n)
  }

  let usage: unknown | null = null
  if (existsSync(usagePath)) {
    try {
      usage = JSON.parse(readFileSync(usagePath, 'utf8'))
    } catch {
      usage = null
    }
  }

  return {
    daemon: { alive: isDaemonAlive(hbPath), heartbeat: readHeartbeat(hbPath) },
    queue,
    tasks: { total, byStatus, ratifiedBacklog, dispatchable: dispatchable.length },
    reactive: { mode: reactiveMode(), ...rc },
    usage,
  }
}

export function formatStatus(d: StatusData): string {
  const hb = d.daemon.heartbeat
  const lines = [
    'BION STATUS',
    '───────────',
    `daemon:    ${d.daemon.alive ? 'ALIVE' : 'down'}${hb ? ` (pid ${hb.pid}, tick ${hb.tick}, ${hb.ts})` : ''}`,
    `modes:     reactive=${d.reactive.mode}  auto=${hb?.mode.auto ?? process.env.BION_AUTO_MODE ?? 'off'}`,
    `outbox:    pending=${d.queue.pending} sending=${d.queue.sending} done=${d.queue.done}`,
    `tasks:     total=${d.tasks.total} ratified-backlog=${d.tasks.ratifiedBacklog} dispatchable=${d.tasks.dispatchable}`,
    `           by-status ${Object.entries(d.tasks.byStatus).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)'}`,
    `reactive:  shadow=${d.reactive.shadow} dispatch=${d.reactive.dispatch} halt=${d.reactive.halt}`,
    `usage:     ${d.usage ? JSON.stringify(d.usage) : 'unknown (no .bion/usage.json)'}`,
  ]
  return lines.join('\n')
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  collectStatus()
    .then((d) => {
      console.log(formatStatus(d))
      return closePool()
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('bion status failed:', err.message)
      process.exit(1)
    })
}
