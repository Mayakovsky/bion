import { existsSync, readFileSync } from 'node:fs'
import { repoPath } from '../paths.js'
import { recordEvent } from '../core/events.js'
import { notifyDurably } from '../db/outbox.js'
import { notifyForces, type NotifyFn, type NotifyResult } from '../notify/ntfy.js'

// Usage tracking (Phase E3) — session length, reset clock, usage; fire an ntfy warning at a
// threshold (~80%). Bion doesn't natively know API usage, so it reads a snapshot an external
// reporter writes to `.bion/usage.json`. The source's accuracy is flagged as an FDQ seed.

export interface UsageSnapshot {
  used: number
  limit: number
  /** Window reset marker; the warning fires at most once per reset window. */
  resetAt: string
  sessionStartMs?: number
}

export interface UsageDeps {
  threshold?: number
  source?: () => UsageSnapshot | null
  usagePath?: string
  notify?: NotifyFn
}

export interface UsageCheck {
  pct: number
  warned: boolean
  snapshot: UsageSnapshot | null
  notified?: NotifyResult
}

export function readUsageFile(path?: string): UsageSnapshot | null {
  const p = path ?? repoPath('.bion', 'usage.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as UsageSnapshot
  } catch {
    return null
  }
}

/**
 * Check usage against the threshold and warn Forces once per reset window. Idempotent: the warning
 * event dedups on the resetAt marker, so repeated checks in the same window don't re-warn.
 */
export async function checkUsage(deps: UsageDeps = {}): Promise<UsageCheck> {
  const snapshot = deps.source ? deps.source() : readUsageFile(deps.usagePath)
  if (!snapshot || !snapshot.limit) return { pct: 0, warned: false, snapshot }

  const pct = snapshot.used / snapshot.limit
  const threshold = deps.threshold ?? 0.8
  if (pct < threshold) return { pct, warned: false, snapshot }

  const dedupKey = `usage.warn:${snapshot.resetAt}`
  const { deduped } = await recordEvent({
    kind: 'usage.warn',
    source: 'usage',
    payload: { pct, resetAt: snapshot.resetAt, used: snapshot.used, limit: snapshot.limit },
    dedupKey,
  })
  if (deduped) return { pct, warned: false, snapshot } // already warned this window

  const notified = await notifyDurably(
    {
      title: `Bion: usage ${Math.round(pct * 100)}%`,
      message: `Usage ${Math.round(pct * 100)}% of window (${snapshot.used}/${snapshot.limit}); resets ${snapshot.resetAt}.`,
      priority: 4,
      tags: ['bion', 'usage'],
    },
    `notify:${dedupKey}`,
    { notify: deps.notify ?? ((i) => notifyForces(i)) },
  )
  return { pct, warned: true, snapshot, notified }
}
