import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { repoPath } from '../paths.js'
import { isDaemonAlive, readHeartbeat, heartbeatPath } from '../daemon/heartbeat.js'
import { notifyForces, type NotifyFn } from '../notify/ntfy.js'

// `bion check-heartbeat` — a standalone liveness
// probe, deliberately NOT part of the daemon: the whole point is to notice when the daemon
// itself is dead, so it can't depend on the daemon (or its DB pool) to run. No DB access here —
// just a heartbeat-file read + a direct ntfy POST. Its threshold (below) is deliberately looser than
// `isDaemonAlive`'s 120s default that `bion status` uses for its own "down" display.
//
// Edge-triggered, not level-triggered: alerts once on the healthy->stale transition, once more
// on stale->healthy (recovery), and stays silent on every other check — a daemon down for six
// hours produces one alert, not one every poll interval.
//
// Anti-flapping: the stale edge needs STALE_CONSECUTIVE_CHECKS stale readings IN A ROW before it
// pages, and the threshold is 180s. The daemon now heartbeats on its own 15s timer, so a healthy
// reading is ~0-20s; 180s plus two consecutive 60s checks means a real outage still pages within
// roughly 4-5 minutes, while one late reading (a briefly blocked event loop, a half-read file) is
// absorbed silently. A "recovered" push only ever follows a "DOWN" push, so absorbed blips produce
// no notice at all, in either direction.
//
// Two distinct pages, same edge-triggered shape: DOWN (heartbeat stale = process dead or event loop
// blocked) and STUCK (heartbeat fresh but no tick has finished for STUCK_MAX_AGE_MS = process alive,
// loop not making progress). A dead process only ever pages DOWN.

export const STALE_MAX_AGE_MS = 180_000
export const STALE_CONSECUTIVE_CHECKS = 2
// STUCK = the process is alive (heartbeat fresh) but no tick has FINISHED for this long. The daemon's
// heartbeat timer proves liveness only; lastTickTs (or startedAt, before the first tick) proves work.
// The longest legitimate tick is the first CI poll after a restart (~62 s measured, bounded at ~150 s
// by CI_POLL_BUDGET_MS plus one call timeout), so 10 minutes leaves >4x margin over even the bounded
// worst case; with the consecutive-check rule a wedged loop pages in about 11-12 minutes.
export const STUCK_MAX_AGE_MS = 600_000

interface AlertState {
  alerted: boolean
  since?: string
  /** Consecutive stale checks seen so far while not yet alerted. */
  staleStreak?: number
  /** STUCK edge, tracked separately from DOWN so each pages and recovers on its own. */
  stuckAlerted?: boolean
  stuckSince?: string
  stuckStreak?: number
}

function statePath(): string {
  return repoPath('.bion', 'daemon', 'heartbeat-alert-state.json')
}

function readState(path = statePath()): AlertState {
  if (!existsSync(path)) return { alerted: false }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AlertState
  } catch {
    return { alerted: false }
  }
}

function writeState(state: AlertState, path = statePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}

export interface CheckDeps {
  hbPath?: string
  statePath?: string
  notify?: NotifyFn
  now?: number
}

export type CheckOutcome =
  | 'alerted-stale'
  | 'alerted-recovered'
  | 'pending-stale'
  | 'quiet-stale'
  | 'quiet-healthy'
  | 'alerted-stuck'
  | 'alerted-stuck-recovered'
  | 'pending-stuck'
  | 'quiet-stuck'

export async function checkHeartbeat(deps: CheckDeps = {}): Promise<{ outcome: CheckOutcome; ageMs: number | null }> {
  const hbPath = deps.hbPath ?? heartbeatPath()
  const sPath = deps.statePath ?? statePath()
  const notify = deps.notify ?? notifyForces
  const now = deps.now ?? Date.now()

  const hb = readHeartbeat(hbPath)
  const alive = isDaemonAlive(hbPath, STALE_MAX_AGE_MS, now)
  const ageMs = hb ? now - new Date(hb.ts).getTime() : null
  const state = readState(sPath)

  if (!alive) {
    // A dead process is DOWN only. Any STUCK episode is dropped silently so it can't also page (or
    // later send a spurious "ticks resumed") on top of the DOWN/recovered pair.
    state.stuckAlerted = false
    state.stuckStreak = 0
    delete state.stuckSince
    if (!state.alerted) {
      const streak = (state.staleStreak ?? 0) + 1
      if (streak < STALE_CONSECUTIVE_CHECKS) {
        writeState({ ...state, alerted: false, staleStreak: streak }, sPath)
        return { outcome: 'pending-stale', ageMs }
      }
      const ageStr = hb ? `${Math.round(ageMs! / 1000)}s` : 'no heartbeat file at all'
      await notify({
        title: 'Bion daemon DOWN',
        message: `heartbeat stale (${ageStr}, threshold ${STALE_MAX_AGE_MS / 1000}s). Check now — this either means the daemon crashed or its scheduled task didn't survive a session/logon boundary (a known failure mode). Run "bion status" or check .bion/daemon/daemon.log on the box.`,
        priority: 5,
        tags: ['bion', 'daemon', 'warning', 'rotating_light'],
      })
      writeState({ alerted: true, since: new Date(now).toISOString() }, sPath)
      return { outcome: 'alerted-stale', ageMs }
    }
    writeState(state, sPath)
    return { outcome: 'quiet-stale', ageMs }
  }

  // Process is alive from here on.
  if (state.alerted) {
    const downSince = state.since ? new Date(state.since).getTime() : now
    const outageMin = Math.round((now - downSince) / 60000)
    await notify({
      title: 'Bion daemon recovered',
      message: `heartbeat fresh again (pid ${hb!.pid}, tick ${hb!.tick}). Was down ~${outageMin} min.`,
      priority: 3,
      tags: ['bion', 'daemon', 'white_check_mark'],
    })
    writeState({ alerted: false }, sPath) // also clears any stale stuck/streak fields: a fresh process starts clean
    return { outcome: 'alerted-recovered', ageMs }
  }

  // "Still doing work?" Reference point is the last finished tick, or the process start before the
  // first tick finishes. A file with neither (older daemon) can't be judged, so it is never stuck.
  const ref = hb!.lastTickTs ?? hb!.startedAt
  const sinceWorkMs = ref ? now - new Date(ref).getTime() : null
  const stuck = sinceWorkMs !== null && sinceWorkMs > STUCK_MAX_AGE_MS

  if (stuck && !state.stuckAlerted) {
    const streak = (state.stuckStreak ?? 0) + 1
    if (streak < STALE_CONSECUTIVE_CHECKS) {
      writeState({ ...state, staleStreak: 0, stuckStreak: streak }, sPath)
      return { outcome: 'pending-stuck', ageMs }
    }
    const mins = Math.round(sinceWorkMs! / 60000)
    await notify({
      title: 'Bion daemon STUCK',
      message: `process is alive (pid ${hb!.pid}, heartbeat ${Math.round(ageMs! / 1000)}s old) but no tick has finished in ${mins} min. Last finished tick: ${hb!.lastTickTs ? `#${hb!.tick} at ${hb!.lastTickTs}` : `none since start at ${hb!.startedAt}`}. Likely a hung outside call or wedged loop — check .bion/daemon/daemon.log, restart via "schtasks /end /tn BionDaemon" then "/run".`,
      priority: 5,
      tags: ['bion', 'daemon', 'warning', 'hourglass'],
    })
    writeState({ alerted: false, stuckAlerted: true, stuckSince: new Date(now).toISOString() }, sPath)
    return { outcome: 'alerted-stuck', ageMs }
  }

  if (!stuck && state.stuckAlerted) {
    const mins = Math.round((now - (state.stuckSince ? new Date(state.stuckSince).getTime() : now)) / 60000)
    await notify({
      title: 'Bion daemon ticks resumed',
      message: `ticks are finishing again (pid ${hb!.pid}, tick ${hb!.tick}). Was stuck ~${mins} min.`,
      priority: 3,
      tags: ['bion', 'daemon', 'white_check_mark'],
    })
    writeState({ alerted: false }, sPath)
    return { outcome: 'alerted-stuck-recovered', ageMs }
  }

  if (stuck) return { outcome: 'quiet-stuck', ageMs } // already paged; stay silent

  // Healthy: drop any absorbed-blip streaks so the next blip counts from zero.
  if (state.staleStreak || state.stuckStreak) writeState({ alerted: false }, sPath)
  return { outcome: 'quiet-healthy', ageMs }
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  checkHeartbeat()
    .then((r) => {
      console.log(`[check-heartbeat] ${r.outcome} (age=${r.ageMs === null ? 'n/a' : `${Math.round(r.ageMs / 1000)}s`})`)
      process.exit(0)
    })
    .catch((err) => {
      console.error('bion check-heartbeat failed:', err.message)
      process.exit(1)
    })
}
