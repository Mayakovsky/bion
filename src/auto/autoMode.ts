import { query } from '../db/pool.js'
import { recordEvent } from '../core/events.js'
import { getTask, setTaskStatus } from '../core/tasks.js'
import { routePacket } from '../core/routing.js'
import { drainOutbox } from '../db/outbox.js'
import { notifyDurably } from '../db/outbox.js'
import { notifyForces, type NotifyFn, type NotifyResult } from '../notify/ntfy.js'
import { DesktopAdapter } from '../adapters/desktop.js'
import { KovAdapter } from '../adapters/kov.js'
import { pointer, serialize } from '../comms/protocol.js'
import type { BreakerConfig } from '../loop/reactive.js'
import type { AgentAdapter, PollResult } from '../adapters/types.js'
import type { Task } from '../core/types.js'
import { checkUsage, type UsageDeps } from './usage.js'

// Auto Mode (Phase E3) — BUILT NOW, SHIPPED OFF (BION_AUTO_MODE default off; the flip is Forces').
//   off     do nothing (surface-only posture handled elsewhere).
//   shadow  log the pivots + dispatches it WOULD make + notify; spends nothing, executes nothing.
//   on      auto-dispatch ratified work to Kov (the unattended engine) within the reactive envelope;
//           Desktop-owned items are QUEUED for when Forces is present, not executed.
// Pivot-on-block: walk projects by ordinal, tasks by priority, skipping blocked work — so a
// roadblock on one project advances the front to the next project's next ratified task.
//
// Directive-20: the unset/unrecognized fallback moved off -> shadow (Forces' explicit call, not a
// bugfix — the "shipped off" posture above was Phase E3's original stance). `off` and `on` remain
// fully available as explicit settings; this only changes what happens when nobody said anything.
// `on` (real autonomous dispatch) is untouched — this is not a step toward defaulting to `on`.

export type AutoMode = 'off' | 'shadow' | 'on'

export function autoModeSetting(): AutoMode {
  const m = (process.env.BION_AUTO_MODE ?? 'shadow').toLowerCase()
  return m === 'off' ? 'off' : m === 'on' ? 'on' : 'shadow'
}

export interface AutoWork {
  task: Task
  pivoted: boolean
}

/** BION_AUTO_SCOPE (directive-23 Part B): comma-separated task-id prefixes or exact ids that
 * bound a trial to a subset of ratified work. Unset/empty = no filter (current behavior). */
function autoScopeFilter(): string | undefined {
  return process.env.BION_AUTO_SCOPE?.trim() || undefined
}

function scopeEntries(scope: string): string[] {
  return scope.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Next ratified, dependency-satisfied task across ordered projects (blocked work skipped).
 * When BION_AUTO_SCOPE is set, restricted to task ids matching one of its prefixes/exact ids. */
export async function selectAutoWork(): Promise<AutoWork | null> {
  const scope = autoScopeFilter()
  const entries = scope ? scopeEntries(scope) : []
  const prefixPatterns = entries.map((e) => `${e}%`)
  const res = await query<Task & { proj_ord: number }>(
    `SELECT t.id, t.title, t.description, t.owner, t.priority, t.status, t.dependencies,
            t.ratified, t.project, t.created, t.updated,
            COALESCE(p.ordinal, 2147483647) AS proj_ord
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project AND p.active
     WHERE t.ratified = true
       AND t.status IN ('backlog','ready')
       AND NOT EXISTS (
         SELECT 1 FROM unnest(t.dependencies) AS dep
         LEFT JOIN tasks d ON d.id = dep
         WHERE d.id IS NULL OR d.status <> 'done'
       )
       AND ($1::text[] IS NULL OR t.id LIKE ANY($1::text[]) OR t.id = ANY($2::text[]))
     ORDER BY proj_ord, t.priority DESC, t.created
     LIMIT 1`,
    [scope ? prefixPatterns : null, scope ? entries : null],
  )
  const row = res.rows[0]
  if (!row) return null
  // pivoted = some earlier-ordinal ratified task is blocked (we advanced past it)
  const blocked = await query<{ one: number }>(
    `SELECT 1 AS one FROM tasks t2
     LEFT JOIN projects p2 ON p2.id = t2.project AND p2.active
     WHERE t2.ratified = true AND t2.status = 'blocked'
       AND COALESCE(p2.ordinal, 2147483647) < $1 LIMIT 1`,
    [row.proj_ord],
  )
  return { task: row, pivoted: (blocked.rowCount ?? 0) > 0 }
}

export interface AutoDeps {
  kov: AgentAdapter
  mailRoot?: string
  notify?: NotifyFn
  mode?: AutoMode
  breaker?: BreakerConfig
}

export interface AutoOutcome {
  mode: AutoMode
  selected?: { taskId: string; owner: string; project: string | null; pivoted: boolean }
  dispatched: boolean
  queuedForDesktop?: boolean
  wouldDispatch?: { taskId: string; owner: string }
  halted?: 'circuit-breaker'
  notified?: NotifyResult
}

function breakerCfg(deps: AutoDeps): BreakerConfig {
  return deps.breaker ?? { max: Number(process.env.BION_REACTIVE_MAX ?? 3), windowMs: Number(process.env.BION_REACTIVE_WINDOW_MS ?? 3_600_000) }
}

// Spend/rate ceiling shared with reactive: count BOTH auto- and reactive-dispatches in the window.
async function autoBreakerTripped(deps: AutoDeps): Promise<boolean> {
  const cfg = breakerCfg(deps)
  const since = new Date((cfg.now?.() ?? Date.now()) - cfg.windowMs).toISOString()
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events WHERE kind IN ('reactive.dispatch','auto.dispatch') AND ts >= $1`,
    [since],
  )
  return Number(res.rows[0]!.n) >= cfg.max
}

// Comms Protocol v1 pointers (E4). `queued` = for Desktop when Forces is present; `dispatch` = Kov.
function taskBody(task: Task, intent: 'dispatch' | 'queue'): string {
  return serialize(
    pointer(intent, {
      refs: [`task:${task.id}`, `bion/${task.id}`],
      fields: { task_id: task.id, project: task.project ?? 'none', owner: task.owner ?? 'kov' },
      note: intent === 'queue' ? 'auto: queued for Forces/Desktop' : 'auto: dispatched from ratified front',
    }),
  )
}

/** One Auto Mode step: pick the next front task and act per mode. */
export async function runAutoStep(deps: AutoDeps): Promise<AutoOutcome> {
  const mode = deps.mode ?? autoModeSetting()
  if (mode === 'off') return { mode: 'off', dispatched: false }

  const pick = await selectAutoWork()
  if (!pick) return { mode, dispatched: false }
  const { task, pivoted } = pick
  const owner = task.owner ?? 'kov'
  const selected = { taskId: task.id, owner, project: task.project, pivoted }
  const notify = deps.notify ?? ((i) => notifyForces(i))

  if (mode === 'shadow') {
    await recordEvent({ kind: 'auto.shadow', source: 'auto', payload: { ...selected }, dedupKey: `auto.shadow:${task.id}` })
    const notified = await notifyDurably(
      { title: `Bion AUTO SHADOW: would dispatch ${task.id}`, message: `SHADOW: would ${owner === 'desktop' ? 'queue for Desktop' : 'dispatch to Kov'} ${task.id} (project ${task.project ?? 'none'}${pivoted ? ', pivoted' : ''}). Nothing fired.`, priority: 3, tags: ['bion', 'auto', 'shadow'] },
      `notify:auto.shadow:${task.id}`,
      { notify: deps.notify },
    )
    return { mode, selected, dispatched: false, wouldDispatch: { taskId: task.id, owner }, notified }
  }

  // mode === 'on'
  if (owner === 'desktop') {
    // Queue for Desktop (read when Forces is present); do not execute. Leaves the front (in_progress).
    await routePacket({ sender: 'bion', recipient: 'desktop', thread: task.id, type: 'queued-work', summary: `queued ${task.id}`, body: taskBody(task, 'queue'), origin: 'bion:auto', mailRoot: deps.mailRoot })
    await drainOutbox({ notify: deps.notify })
    await setTaskStatus(task.id, 'in_progress')
    return { mode, selected, dispatched: false, queuedForDesktop: true }
  }

  if (await autoBreakerTripped(deps)) {
    await recordEvent({ kind: 'auto.halt', source: 'auto', payload: { taskId: task.id, reason: 'circuit-breaker' }, dedupKey: `auto.halt:${task.id}:${new Date().toISOString().slice(0, 13)}` })
    const notified = await notify({ title: 'Bion: AUTO halted (circuit-breaker)', message: `Auto-dispatch ceiling hit; withheld ${task.id}.`, priority: 5, tags: ['bion', 'auto', 'halt'] })
    return { mode, selected, dispatched: false, halted: 'circuit-breaker', notified }
  }

  await setTaskStatus(task.id, 'in_progress')
  await recordEvent({ kind: 'auto.dispatch', source: 'auto', payload: { taskId: task.id, owner: 'kov', project: task.project }, dedupKey: `auto.dispatch:${task.id}` })
  await deps.kov.dispatch({ sender: 'bion', recipient: 'kov', thread: task.id, type: 'task', summary: `task ${task.id}`, body: taskBody(task, 'dispatch'), origin: 'bion:auto' })
  const notified = await notify({ title: `Bion: auto-dispatched ${task.id}`, message: `Auto-dispatched ${task.id} to Kov (project ${task.project ?? 'none'}).`, priority: 4, tags: ['bion', 'auto', 'dispatch'] })
  return { mode, selected, dispatched: true, notified }
}

/** Desktop auto-reads its inbox at session launch (spec §5; Auto Mode requirement). */
export async function desktopLaunchRead(opts: { mailRoot?: string } = {}): Promise<PollResult> {
  return new DesktopAdapter({ mailRoot: opts.mailRoot }).pollStatus()
}

/** Daemon tick hook: usage check + one Auto Mode step. */
export async function autoTick(deps: { kov?: AgentAdapter; mailRoot?: string; notify?: NotifyFn; usage?: UsageDeps }): Promise<void> {
  await checkUsage(deps.usage ?? { notify: deps.notify })
  await runAutoStep({ kov: deps.kov ?? new KovAdapter({ mailRoot: deps.mailRoot }), mailRoot: deps.mailRoot, notify: deps.notify })
}
