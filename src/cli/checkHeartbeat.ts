import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { repoPath } from '../paths.js'
import { isDaemonAlive, readHeartbeat, heartbeatPath } from '../daemon/heartbeat.js'
import { notifyForces, type NotifyFn } from '../notify/ntfy.js'

const execFileAsync = promisify(execFile)

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
//
// Boot/logon awareness: the PC is shut down nightly and the daemon only launches at interactive logon
// (BionDaemon's AtLogOn trigger), so the previous night's heartbeat is always stale at first boot —
// that is "the machine was off", not an outage. Staleness is therefore measured from the LATER of the
// heartbeat and (interactive logon + LOGON_GRACE_MS), nothing pages before anyone has logged in, and
// state carried over from before the last boot is dropped silently (no orphan "recovered" push). A
// daemon that does NOT come up after logon still pages, with a message saying so. If the session probe
// fails, none of this applies and the plain threshold rules above decide — a probe failure can only
// make this checker noisier, never quieter.

export const STALE_MAX_AGE_MS = 180_000
export const STALE_CONSECUTIVE_CHECKS = 2
// STUCK = the process is alive (heartbeat fresh) but no tick has FINISHED for this long. The daemon's
// heartbeat timer proves liveness only; lastTickTs (or startedAt, before the first tick) proves work.
// The longest legitimate tick is the first CI poll after a restart (~62 s measured, bounded at ~150 s
// by CI_POLL_BUDGET_MS plus one call timeout), so 10 minutes leaves >4x margin over even the bounded
// worst case; with the consecutive-check rule a wedged loop pages in about 11-12 minutes.
export const STUCK_MAX_AGE_MS = 600_000
// How long after interactive logon the daemon gets to start beating before its absence counts. The
// daemon launches the instant the AtLogOn trigger fires and wrote its first heartbeat ~16 s later
// (measured); BionDaemon's Restart-on-failure retries up to 3 times at 1-minute intervals, so 4 minutes
// covers a normal start AND every scheduled retry. A DOWN then still needs STALE_MAX_AGE_MS more plus
// STALE_CONSECUTIVE_CHECKS, i.e. a daemon that never starts pages roughly 7-8 minutes after logon.
export const LOGON_GRACE_MS = 240_000

interface AlertState {
  alerted: boolean
  since?: string
  /** Consecutive stale checks seen so far while not yet alerted. */
  staleStreak?: number
  /** STUCK edge, tracked separately from DOWN so each pages and recovers on its own. */
  stuckAlerted?: boolean
  stuckSince?: string
  stuckStreak?: number
  /** When this state was last written; lets a later boot recognise state left over from before it. */
  updatedAt?: string
}

/** What the machine says about the current boot and interactive session. */
export interface SessionInfo {
  /** Epoch ms of the last boot. */
  bootMs: number
  /** Epoch ms the user's interactive session began, or null if nobody is logged in. */
  logonMs: number | null
}
export type SessionProbe = () => Promise<SessionInfo | null>

// Source of truth for logon time: the start time of the user's interactive (non-zero session)
// explorer.exe, which the shell launches at logon and which is exactly when the AtLogOn trigger fires
// (measured 10-28: explorer 08:28:17, daemon launch 08:28:17.6). Win32_LogonSession can't be mapped to a
// user without several joins, and quser isn't present on Home editions. One CIM round trip, ~350 ms,
// and only made when a stale/alerted state actually needs it. Caveat: if explorer itself restarts
// mid-session the logon time moves later, which can only DELAY a DOWN page by one grace period.
const PROBE_SCRIPT = [
  "$b=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
  '$me=[Environment]::UserName; $l=$null',
  "foreach($p in Get-CimInstance Win32_Process -Filter \"Name='explorer.exe'\"){",
  '  if($p.SessionId -eq 0){continue}',
  '  $o=Invoke-CimMethod -InputObject $p -MethodName GetOwner',
  '  if($o.User -eq $me){$t=$p.CreationDate.ToUniversalTime(); if($l -eq $null -or $t -lt $l){$l=$t}}',
  '}',
  "ConvertTo-Json @{boot=$b; logon=$(if($l){$l.ToString('o')}else{$null})} -Compress",
].join('; ')

export async function probeSession(): Promise<SessionInfo | null> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT], {
      timeout: 15_000,
      windowsHide: true,
    })
    const j = JSON.parse(stdout.trim()) as { boot: string; logon: string | null }
    const bootMs = new Date(j.boot).getTime()
    if (Number.isNaN(bootMs)) return null
    return { bootMs, logonMs: j.logon ? new Date(j.logon).getTime() : null }
  } catch {
    return null
  }
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
  /** Boot/logon probe override (tests). Defaults to the real CIM probe. */
  session?: SessionProbe
}

export type CheckOutcome =
  | 'alerted-stale'
  | 'alerted-recovered'
  | 'pending-stale'
  | 'quiet-stale'
  | 'quiet-healthy'
  | 'quiet-prelogon'
  | 'quiet-grace'
  | 'alerted-stuck'
  | 'alerted-stuck-recovered'
  | 'pending-stuck'
  | 'quiet-stuck'

export interface CheckResult {
  outcome: CheckOutcome
  ageMs: number | null
  /** Present only when the session probe ran this check (diagnostics for the log line). */
  session?: SessionInfo | null
}

export async function checkHeartbeat(deps: CheckDeps = {}): Promise<CheckResult> {
  const hbPath = deps.hbPath ?? heartbeatPath()
  const sPath = deps.statePath ?? statePath()
  const notify = deps.notify ?? notifyForces
  const now = deps.now ?? Date.now()
  const stamp = (s: AlertState): AlertState => ({ ...s, updatedAt: new Date(now).toISOString() })

  const hb = readHeartbeat(hbPath)
  const alive = isDaemonAlive(hbPath, STALE_MAX_AGE_MS, now)
  const ageMs = hb ? now - new Date(hb.ts).getTime() : null
  let state = readState(sPath)

  // Ask the machine about boot/logon only when it can change the answer: the heartbeat is stale, or
  // there is alert state that might be left over from before a reboot. Healthy minutes stay free.
  const needsProbe = !alive || state.alerted || !!state.staleStreak || !!state.stuckAlerted || !!state.stuckStreak
  const session = needsProbe ? await (deps.session ?? probeSession)().catch(() => null) : undefined

  // State written before the last boot describes a previous life; drop it silently so a morning
  // start can't emit an orphan "recovered" (or inherit a stale streak and page on its first check).
  if (session) {
    const wrote = state.updatedAt ?? state.since ?? state.stuckSince
    if (wrote && new Date(wrote).getTime() < session.bootMs) {
      state = { alerted: false }
      writeState(stamp(state), sPath) // persist the drop, or every later check would re-probe for nothing
    }
  }

  if (!alive) {
    // A dead process is DOWN only. Any STUCK episode is dropped silently so it can't also page (or
    // later send a spurious "ticks resumed") on top of the DOWN/recovered pair.
    state.stuckAlerted = false
    state.stuckStreak = 0
    delete state.stuckSince

    const hbMs = hb ? new Date(hb.ts).getTime() : 0
    let failedToStart = false
    if (session) {
      if (session.logonMs === null) {
        // Nobody is logged in. If the daemon never beat this boot it simply cannot have started yet
        // (it launches at logon): silent. If it DID beat this boot, the session ending killed it — a
        // real failure — and the normal DOWN rules below apply.
        if (hbMs < session.bootMs) {
          writeState(stamp({ alerted: false }), sPath)
          return { outcome: 'quiet-prelogon', ageMs, session }
        }
      } else if (hbMs < session.logonMs) {
        // Logged in, but the daemon hasn't beaten since logon. Grace for it to launch, then the usual
        // staleness threshold counted from the end of the grace window.
        const graceEnd = session.logonMs + LOGON_GRACE_MS
        if (now - graceEnd <= STALE_MAX_AGE_MS) {
          if (!state.alerted) writeState(stamp({ ...state, alerted: false, staleStreak: 0 }), sPath)
          return { outcome: 'quiet-grace', ageMs, session }
        }
        failedToStart = true
      }
    }

    if (!state.alerted) {
      const streak = (state.staleStreak ?? 0) + 1
      if (streak < STALE_CONSECUTIVE_CHECKS) {
        writeState(stamp({ ...state, alerted: false, staleStreak: streak }), sPath)
        return { outcome: 'pending-stale', ageMs, session }
      }
      const message = failedToStart
        ? `daemon failed to come up after logon: no heartbeat since the interactive logon at ${new Date(session!.logonMs!).toISOString()} (${Math.round((now - session!.logonMs!) / 60000)} min ago; grace ${LOGON_GRACE_MS / 60000} min). The scheduled task BionDaemon did not start it or it exited. Check .bion/daemon/daemon.log, then "schtasks /run /tn BionDaemon".`
        : `heartbeat stale (${hb ? `${Math.round(ageMs! / 1000)}s` : 'no heartbeat file at all'}, threshold ${STALE_MAX_AGE_MS / 1000}s). Check now — this either means the daemon crashed or its scheduled task didn't survive a session/logon boundary (a known failure mode). Run "bion status" or check .bion/daemon/daemon.log on the box.`
      await notify({
        title: 'Bion daemon DOWN',
        message,
        priority: 5,
        tags: ['bion', 'daemon', 'warning', 'rotating_light'],
      })
      writeState(stamp({ alerted: true, since: new Date(now).toISOString() }), sPath)
      return { outcome: 'alerted-stale', ageMs, session }
    }
    writeState(stamp(state), sPath)
    return { outcome: 'quiet-stale', ageMs, session }
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
    writeState(stamp({ alerted: false }), sPath) // also clears any stale stuck/streak fields: a fresh process starts clean
    return { outcome: 'alerted-recovered', ageMs, session }
  }

  // "Still doing work?" Reference point is the last finished tick, or the process start before the
  // first tick finishes. A file with neither (older daemon) can't be judged, so it is never stuck. A
  // fresh start cannot read as stuck inside the logon grace by construction: startedAt is no earlier than
  // the logon and STUCK_MAX_AGE_MS (10 min) is longer than LOGON_GRACE_MS (4 min).
  const ref = hb!.lastTickTs ?? hb!.startedAt
  const sinceWorkMs = ref ? now - new Date(ref).getTime() : null
  const stuck = sinceWorkMs !== null && sinceWorkMs > STUCK_MAX_AGE_MS

  if (stuck && !state.stuckAlerted) {
    const streak = (state.stuckStreak ?? 0) + 1
    if (streak < STALE_CONSECUTIVE_CHECKS) {
      writeState(stamp({ ...state, staleStreak: 0, stuckStreak: streak }), sPath)
      return { outcome: 'pending-stuck', ageMs, session }
    }
    const mins = Math.round(sinceWorkMs! / 60000)
    await notify({
      title: 'Bion daemon STUCK',
      message: `process is alive (pid ${hb!.pid}, heartbeat ${Math.round(ageMs! / 1000)}s old) but no tick has finished in ${mins} min. Last finished tick: ${hb!.lastTickTs ? `#${hb!.tick} at ${hb!.lastTickTs}` : `none since start at ${hb!.startedAt}`}. Likely a hung outside call or wedged loop — check .bion/daemon/daemon.log, restart via "schtasks /end /tn BionDaemon" then "/run".`,
      priority: 5,
      tags: ['bion', 'daemon', 'warning', 'hourglass'],
    })
    writeState(stamp({ alerted: false, stuckAlerted: true, stuckSince: new Date(now).toISOString() }), sPath)
    return { outcome: 'alerted-stuck', ageMs, session }
  }

  if (!stuck && state.stuckAlerted) {
    const mins = Math.round((now - (state.stuckSince ? new Date(state.stuckSince).getTime() : now)) / 60000)
    await notify({
      title: 'Bion daemon ticks resumed',
      message: `ticks are finishing again (pid ${hb!.pid}, tick ${hb!.tick}). Was stuck ~${mins} min.`,
      priority: 3,
      tags: ['bion', 'daemon', 'white_check_mark'],
    })
    writeState(stamp({ alerted: false }), sPath)
    return { outcome: 'alerted-stuck-recovered', ageMs, session }
  }

  if (stuck) return { outcome: 'quiet-stuck', ageMs, session } // already paged; stay silent

  // Healthy: drop any absorbed-blip streaks so the next blip counts from zero.
  if (state.staleStreak || state.stuckStreak) writeState(stamp({ alerted: false }), sPath)
  return { outcome: 'quiet-healthy', ageMs, session }
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  checkHeartbeat()
    .then((r) => {
      const sess =
        r.session === undefined
          ? ''
          : r.session === null
            ? ' session=probe-failed'
            : ` boot=${new Date(r.session.bootMs).toISOString()} logon=${r.session.logonMs === null ? 'none' : new Date(r.session.logonMs).toISOString()}`
      console.log(`[check-heartbeat] ${r.outcome} (age=${r.ageMs === null ? 'n/a' : `${Math.round(r.ageMs / 1000)}s`})${sess}`)
      process.exit(0)
    })
    .catch((err) => {
      console.error('bion check-heartbeat failed:', err.message)
      process.exit(1)
    })
}
