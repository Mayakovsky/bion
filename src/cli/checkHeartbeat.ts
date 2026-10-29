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

export const STALE_MAX_AGE_MS = 180_000
export const STALE_CONSECUTIVE_CHECKS = 2

interface AlertState {
  alerted: boolean
  since?: string
  /** Consecutive stale checks seen so far while not yet alerted. */
  staleStreak?: number
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

export type CheckOutcome = 'alerted-stale' | 'alerted-recovered' | 'pending-stale' | 'quiet-stale' | 'quiet-healthy'

export async function checkHeartbeat(deps: CheckDeps = {}): Promise<{ outcome: CheckOutcome; ageMs: number | null }> {
  const hbPath = deps.hbPath ?? heartbeatPath()
  const sPath = deps.statePath ?? statePath()
  const notify = deps.notify ?? notifyForces
  const now = deps.now ?? Date.now()

  const hb = readHeartbeat(hbPath)
  const alive = isDaemonAlive(hbPath, STALE_MAX_AGE_MS, now)
  const ageMs = hb ? now - new Date(hb.ts).getTime() : null
  const state = readState(sPath)

  if (!alive && !state.alerted) {
    const streak = (state.staleStreak ?? 0) + 1
    if (streak < STALE_CONSECUTIVE_CHECKS) {
      writeState({ alerted: false, staleStreak: streak }, sPath)
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

  if (alive && state.alerted) {
    const downSince = state.since ? new Date(state.since).getTime() : now
    const outageMin = Math.round((now - downSince) / 60000)
    await notify({
      title: 'Bion daemon recovered',
      message: `heartbeat fresh again (pid ${hb!.pid}, tick ${hb!.tick}). Was down ~${outageMin} min.`,
      priority: 3,
      tags: ['bion', 'daemon', 'white_check_mark'],
    })
    writeState({ alerted: false }, sPath)
    return { outcome: 'alerted-recovered', ageMs }
  }

  if (alive && state.staleStreak) writeState({ alerted: false }, sPath) // blip absorbed, streak reset
  return { outcome: alive ? 'quiet-healthy' : 'quiet-stale', ageMs }
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
