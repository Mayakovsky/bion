import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { query, closePool } from '../db/pool.js'

// `bion auto-report` (directive-19) — read-only console surface, sibling to `bion status`/`bion cost`.
// Reads events WHERE kind = 'auto.shadow' only, for now — auto.dispatch/auto.halt have a different
// payload shape and matter once `on` mode is live for real, not before.
//
// auto.shadow's dedup_key is `auto.shadow:<task.id>` (src/auto/autoMode.ts), so this table is
// naturally one row per distinct task ever shadow-picked, not per daemon tick — no separate
// "distinct" query needed, the ledger already is one.

interface RawShadowRow {
  id: string
  ts: Date
  payload: Record<string, unknown>
}

export interface ShadowPick {
  taskId: string
  project: string
  owner: string
  pivoted: boolean
  ts: Date
}

/** No sanity guard the way cost needed one — these are counts/booleans, not untrusted external
 * numbers. A malformed payload (missing taskId) is just skipped, not flagged/thrown. */
function parseShadowRow(row: RawShadowRow): ShadowPick | null {
  const taskId = row.payload?.taskId
  if (typeof taskId !== 'string' || !taskId) return null
  const project = typeof row.payload?.project === 'string' ? row.payload.project : 'none'
  const owner = typeof row.payload?.owner === 'string' ? row.payload.owner : 'unknown'
  const pivoted = row.payload?.pivoted === true
  return { taskId, project, owner, pivoted, ts: row.ts }
}

export interface AutoReportScale {
  total: number
  byProject: Record<string, number>
  byOwner: Record<string, number>
  pivoted: number
}

function aggregateShadow(picks: ShadowPick[]): AutoReportScale {
  const byProject: Record<string, number> = {}
  const byOwner: Record<string, number> = {}
  let pivoted = 0
  for (const p of picks) {
    byProject[p.project] = (byProject[p.project] ?? 0) + 1
    byOwner[p.owner] = (byOwner[p.owner] ?? 0) + 1
    if (p.pivoted) pivoted++
  }
  return { total: picks.length, byProject, byOwner, pivoted }
}

export interface AutoReportData {
  allTime: AutoReportScale
  daily: AutoReportScale
  monthly: AutoReportScale
  /** One row per distinct taskId ever shadow-picked (see module note on dedup_key). */
  tasks: ShadowPick[]
  /** auto.shadow rows with no usable taskId in payload — skipped, not counted anywhere above. */
  skipped: number
}

export interface AutoReportOptions {
  now?: Date
}

export async function collectAutoReport(opts: AutoReportOptions = {}): Promise<AutoReportData> {
  const now = opts.now ?? new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const res = await query<RawShadowRow>(`SELECT id, ts, payload FROM events WHERE kind = 'auto.shadow' ORDER BY ts ASC`)

  let skipped = 0
  const picks: ShadowPick[] = []
  for (const row of res.rows) {
    const p = parseShadowRow(row)
    if (!p) {
      skipped++
      continue
    }
    picks.push(p)
  }

  return {
    allTime: aggregateShadow(picks),
    daily: aggregateShadow(picks.filter((p) => p.ts >= dayAgo)),
    monthly: aggregateShadow(picks.filter((p) => p.ts >= monthAgo)),
    tasks: picks,
    skipped,
  }
}

function formatScale(title: string, s: AutoReportScale): string[] {
  const byProject = Object.entries(s.byProject).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)'
  const byOwner = Object.entries(s.byOwner).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)'
  return [title, `  total=${s.total} pivoted=${s.pivoted}`, `  by-project ${byProject}`, `  by-owner   ${byOwner}`]
}

export function formatAutoReport(d: AutoReportData): string {
  const lines = ['BION AUTO-REPORT', '────────────────']
  lines.push(...formatScale('ALL-TIME', d.allTime), '')
  lines.push(...formatScale('LAST 24H', d.daily), '')
  lines.push(...formatScale('LAST 30D', d.monthly), '')
  lines.push('DISTINCT TASKS (one per task ever shadow-picked)')
  if (!d.tasks.length) {
    lines.push('  (none)')
  } else {
    for (const t of d.tasks) {
      lines.push(
        `  ${t.taskId.padEnd(20)} project=${t.project.padEnd(14)} owner=${t.owner.padEnd(8)} pivoted=${t.pivoted} first-seen=${t.ts.toISOString()}`,
      )
    }
  }
  if (d.skipped > 0) lines.push('', `! ${d.skipped} auto.shadow event(s) skipped (malformed payload)`)
  return lines.join('\n')
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  collectAutoReport()
    .then((d) => {
      console.log(formatAutoReport(d))
      return closePool()
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('bion auto-report failed:', err.message)
      process.exit(1)
    })
}
