import { join } from 'node:path'
import { query } from '../db/pool.js'
import { recordEvent } from '../core/events.js'
import { createTask, getTask } from '../core/tasks.js'
import { routePacket } from '../core/routing.js'
import { notifyDurably } from '../db/outbox.js'
import { mailboxRoot } from '../mailbox/mailbox.js'
import { pointer, serialize } from '../comms/protocol.js'
import type { NotifyFn, NotifyResult } from '../notify/ntfy.js'
import type { AgentAdapter } from '../adapters/types.js'
import type { Task } from '../core/types.js'
import type { TestSignal } from '../watchers/types.js'

// Reactive dispatch — BUILT NOW, SHIPPED OFF (Phase D2). The full path exists; the flip
// off → shadow → on is a config change and Forces' call, informed by shadow data.
//
//  off / surface (default live behavior): failure → auto-create an UNRATIFIED task + notify Forces
//                 + queue Desktop review. No dispatch (consistent with FDQ-B3).
//  shadow:        as surface, plus log the dispatch it WOULD have fired (task/branch/trigger) + notify.
//  on:            auto-dispatch to Kov within a BOUNDED envelope — only a failure on a ratified
//                 task's own feature branch; circuit breaker (max N / window); loop-halt (a repeat
//                 failure after an auto-fix stops, never re-dispatches); the breaker doubles as the
//                 spend/rate ceiling. Every auto-dispatch is logged, notified, haltable.

export type ReactiveMode = 'off' | 'surface' | 'shadow' | 'on'

const FEATURE_PREFIX = 'bion/'

export function reactiveMode(): ReactiveMode {
  const m = (process.env.BION_REACTIVE_DISPATCH ?? 'off').toLowerCase()
  if (m === 'shadow') return 'shadow'
  if (m === 'on') return 'on'
  return 'off' // 'off' and 'surface' are the same default live behavior
}

export interface BreakerConfig {
  max: number
  windowMs: number
  now?: () => number
}

function breakerConfig(deps: ReactiveDeps): BreakerConfig {
  return (
    deps.breaker ?? {
      max: Number(process.env.BION_REACTIVE_MAX ?? 3),
      windowMs: Number(process.env.BION_REACTIVE_WINDOW_MS ?? 3_600_000),
    }
  )
}

export interface ReactiveDeps {
  kov: AgentAdapter
  mailRoot?: string
  notify?: NotifyFn
  mode?: ReactiveMode
  breaker?: BreakerConfig
}

export interface ReactiveOutcome {
  mode: ReactiveMode
  taskId?: string
  dispatched: boolean
  wouldDispatch?: { taskId: string; targetBranch: string; trigger: string }
  halted?: 'not-ratified-branch' | 'loop-halt' | 'circuit-breaker'
  reviewPath?: string
  notified?: NotifyResult
}

/** A branch `bion/<taskId>` maps to task `<taskId>` (feature-branch convention). Fallback only
 *  (directive-91) — kept exactly as it worked before, for bion's own already-working branches. */
function taskIdFromBranch(branch: string): string | null {
  return branch.startsWith(FEATURE_PREFIX) ? branch.slice(FEATURE_PREFIX.length) : null
}

/** Explicit binding first (directive-91) — real lookup by the `branch` column a task was bound
 *  to via `bindBranch()`, not a guess from the branch string. This is what makes reactive dispatch
 *  usable on repos like `grey`, whose branches never follow bion's own `bion/<taskId>` naming
 *  culture. Falls back to the string-match convention only when no explicit binding exists, so
 *  bion's own existing branches keep working unchanged. */
async function ratifiedTaskForBranch(branch: string): Promise<Task | null> {
  const bound = await query<Task>(
    `SELECT id, title, description, owner, priority, status, dependencies, ratified, project, branch, created, updated
     FROM tasks WHERE branch = $1 AND ratified = true`,
    [branch],
  )
  if (bound.rows[0]) return bound.rows[0]

  const id = taskIdFromBranch(branch)
  if (!id) return null
  const task = await getTask(id)
  return task && task.ratified ? task : null
}

async function hasPriorDispatch(taskId: string): Promise<boolean> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events WHERE kind = 'reactive.dispatch' AND payload->>'taskId' = $1`,
    [taskId],
  )
  return Number(res.rows[0]!.n) > 0
}

async function breakerTripped(deps: ReactiveDeps): Promise<boolean> {
  const cfg = breakerConfig(deps)
  const nowMs = cfg.now?.() ?? Date.now()
  const since = new Date(nowMs - cfg.windowMs).toISOString()
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events WHERE kind = 'reactive.dispatch' AND ts >= $1`,
    [since],
  )
  return Number(res.rows[0]!.n) >= cfg.max
}

/** The bounded-envelope decision (shared by `shadow` and `on`). */
async function decide(
  signal: TestSignal,
  deps: ReactiveDeps,
): Promise<{ dispatch: boolean; task: Task | null; haltReason?: ReactiveOutcome['halted'] }> {
  const task = await ratifiedTaskForBranch(signal.branch)
  if (!task) return { dispatch: false, task: null, haltReason: 'not-ratified-branch' }
  if (await hasPriorDispatch(task.id)) return { dispatch: false, task, haltReason: 'loop-halt' }
  if (await breakerTripped(deps)) return { dispatch: false, task, haltReason: 'circuit-breaker' }
  return { dispatch: true, task }
}

function autofixTaskId(signal: TestSignal): string {
  return `autofix-${signal.branch.replace(/[^a-zA-Z0-9]+/g, '-')}-${signal.runId}`
}

/** Default live behavior: create an unratified task, queue a Desktop review, notify Forces. No dispatch. */
async function surface(signal: TestSignal, deps: ReactiveDeps): Promise<{ taskId: string; reviewPath: string; notified?: NotifyResult }> {
  const taskId = autofixTaskId(signal)
  if (!(await getTask(taskId))) {
    await createTask({
      id: taskId,
      title: `Investigate failing tests on ${signal.branch}`,
      description: `Watcher-detected ${signal.failed}/${signal.total} failing: ${signal.failedTests.join(', ')}`,
    })
  }
  const reviewBody = serialize(
    pointer('review', {
      refs: [`task:${taskId}`, signal.branch, ...signal.failedTests.slice(0, 3)],
      fields: { task_id: taskId, branch: signal.branch, failed: String(signal.failed), total: String(signal.total) },
      note: 'watcher: tests red; ratify to enable a fix',
    }),
  )
  const routed = await routePacket({ sender: 'bion', recipient: 'desktop', thread: taskId, type: 'review-request', summary: `review ${taskId}`, body: reviewBody, origin: 'bion:watcher', mailRoot: deps.mailRoot })
  // notifyDurably drains — it both publishes the routed review and sends the notification durably.
  const notified = await notifyDurably(
    {
      title: `Bion: test failure on ${signal.branch}`,
      message: `Auto-created unratified task ${taskId} from failing tests (${signal.failedTests.join(', ') || 'unnamed'}). Review + ratify to proceed.`,
      priority: 4,
      tags: ['bion', 'watcher', 'test'],
    },
    `notify:watcher:${signal.branch}:${signal.runId}`,
    deps,
  )
  return { taskId, reviewPath: routed.finalPath, notified }
}

/** React to a test-FAILURE signal per the active mode. (Passes are handled by the caller.) */
export async function onTestFailure(signal: TestSignal, deps: ReactiveDeps): Promise<ReactiveOutcome> {
  const mode = deps.mode ?? reactiveMode()

  if (mode === 'on') {
    const d = await decide(signal, deps)
    if (d.dispatch && d.task) {
      await recordEvent({
        kind: 'reactive.dispatch',
        source: 'reactive',
        payload: { taskId: d.task.id, branch: signal.branch, trigger: 'test.failed', runId: signal.runId },
        dedupKey: `reactive.dispatch:${d.task.id}:${signal.runId}`,
      })
      const body = serialize(
        pointer('autofix', {
          refs: [`task:${d.task.id}`, signal.branch, ...signal.failedTests.slice(0, 3)],
          fields: { task_id: d.task.id, branch: signal.branch, failed: String(signal.failed) },
          note: 'auto-fix ratified branch; tests red; gated acts stop at Forces',
        }),
      )
      await deps.kov.dispatch({ sender: 'bion', recipient: 'kov', thread: d.task.id, type: 'autofix', summary: `autofix ${d.task.id}`, body, origin: 'bion:reactive' })
      const notified = await notifyDurably(
        {
          title: `Bion: auto-dispatched fix for ${d.task.id}`,
          message: `Auto-dispatched a fix to Kov for ratified task ${d.task.id} on ${signal.branch} (bounded envelope).`,
          priority: 4,
          tags: ['bion', 'reactive', 'dispatch'],
        },
        `notify:dispatch:${d.task.id}:${signal.runId}`,
        deps,
      )
      return { mode, taskId: d.task.id, dispatched: true, notified }
    }

    // envelope blocked — surface instead, and flag the halt reason
    const s = await surface(signal, deps)
    if (d.haltReason === 'loop-halt' || d.haltReason === 'circuit-breaker') {
      await recordEvent({ kind: 'reactive.halt', source: 'reactive', payload: { taskId: d.task?.id, branch: signal.branch, reason: d.haltReason, runId: signal.runId }, dedupKey: `reactive.halt:${signal.branch}:${signal.runId}` })
      const notified = await notifyDurably(
        { title: `Bion: auto-fix HALTED (${d.haltReason})`, message: `Auto-fix halted for ${d.task?.id ?? signal.branch} on ${signal.branch}: ${d.haltReason}.`, priority: 5, tags: ['bion', 'reactive', 'halt'] },
        `notify:halt:${signal.branch}:${signal.runId}`,
        deps,
      )
      return { mode, taskId: s.taskId, dispatched: false, halted: d.haltReason, reviewPath: s.reviewPath, notified }
    }
    return { mode, taskId: s.taskId, dispatched: false, halted: d.haltReason, reviewPath: s.reviewPath, notified: s.notified }
  }

  if (mode === 'shadow') {
    const s = await surface(signal, deps)
    const d = await decide(signal, deps)
    if (d.dispatch && d.task) {
      const wouldDispatch = { taskId: d.task.id, targetBranch: signal.branch, trigger: 'test.failed' }
      await recordEvent({ kind: 'reactive.shadow', source: 'reactive', payload: { ...wouldDispatch, runId: signal.runId }, dedupKey: `reactive.shadow:${d.task.id}:${signal.runId}` })
      const notified = await notifyDurably(
        { title: `Bion SHADOW: would auto-dispatch ${d.task.id}`, message: `SHADOW: would auto-dispatch a fix for ${d.task.id} on ${signal.branch}. Nothing fired.`, priority: 3, tags: ['bion', 'reactive', 'shadow'] },
        `notify:shadow:${d.task.id}:${signal.runId}`,
        deps,
      )
      return { mode, taskId: s.taskId, dispatched: false, wouldDispatch, reviewPath: s.reviewPath, notified }
    }
    return { mode, taskId: s.taskId, dispatched: false, halted: d.haltReason, reviewPath: s.reviewPath, notified: s.notified }
  }

  // off / surface
  const s = await surface(signal, deps)
  return { mode: 'off', taskId: s.taskId, dispatched: false, reviewPath: s.reviewPath, notified: s.notified }
}
