import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { drainOutbox, reconcile, notifyDurably } from '../db/outbox.js'
import { recordEvent } from '../core/events.js'
import { reactiveMode } from '../loop/reactive.js'
import { autoModeSetting } from '../auto/autoMode.js'
import { closePool, isConnectionError } from '../db/pool.js'
import { pollGit, createGitPollState, type RepoRef } from '../watchers/gitWatcher.js'
import { pollTests, createTestPollState } from '../watchers/testWatcher.js'
import { pollCI, createCIPollState } from '../watchers/ciWatcher.js'
import { discoverRepos } from '../watchers/discovery.js'
import { KovAdapter } from '../adapters/kov.js'
import type { ReactiveDeps } from '../loop/reactive.js'
import { ensureClusterUp, type EnsureClusterOptions } from './cluster.js'
import { acquireLock, releaseLock, pidfilePath } from './lock.js'
import { heartbeatPath, writeHeartbeat, type Heartbeat } from './heartbeat.js'
import { env } from '../env.js'

// Persistent daemon — makes Bion a live process so the outbox, watchers, and (later)
// the Auto Mode loop actually run. Local-while-machine-is-up is the accepted posture; the
// scheduled-task-at-logon mechanism (scripts/install-daemon.ps1) restarts it across logout/restart.
//
// SAFE BY DEFAULT: with BION_AUTO_MODE unset/shadow it logs would-dispatch and fires
// nothing; with BION_REACTIVE_DISPATCH at shadow the reactive path only logs. The tick just drains
// durable side effects + heartbeats.

export interface DaemonOptions {
  intervalMs?: number
  /** How often the liveness heartbeat is rewritten, independent of tick length. Default 15s. */
  heartbeatIntervalMs?: number
  heartbeatPath?: string
  reconcileOnStart?: boolean
  /** Poll git HEAD each tick and emit a commit signal (live watcher). Default true. */
  watchGit?: boolean
  /** Poll for vitest JSON result files each tick and emit a test signal (live watcher).
   *  Default true. */
  watchTests?: boolean
  /** Poll GitHub Actions for each watched repo's CI runs (rate-limited internally, not every
   *  tick). Default true. */
  watchCI?: boolean
  /** Override CIWatcher's per-repo poll interval (tests use a tiny value; default 5 min). */
  ciPollIntervalMs?: number
  /** Reactive-engine deps for the test watcher (kov adapter, mailRoot, notify override) —
   *  tests isolate this; real runs fall back to a real KovAdapter + real notify. */
  reactiveDeps?: Partial<ReactiveDeps>
  /** Ensure the :5433 cluster is up on start / after a tick error. false disables (tests). */
  cluster?: EnsureClusterOptions | false
  /** Single-instance pidfile path override (tests isolate this). */
  pidfile?: string
  /** Extension hook (Auto Mode / usage checks are wired in here in E3). */
  onTick?: (tick: number) => Promise<void>
}

// Live git watcher: emit a commit signal when a watched repo's HEAD moves. Idempotent by sha per
// repo; gitPollState avoids a DB round-trip every tick. Dev-root-wide auto-discovery (replaces
// the old bion+GREY_REPO_PATH static list): every repo discoverRepos() finds under
// env.devRoot, re-discovered each tick so a repo added mid-run is picked up without a restart.
const gitPollState = createGitPollState()
const testPollState = createTestPollState()
const ciPollState = createCIPollState()
function watchedRepos(): RepoRef[] {
  return discoverRepos(env.devRoot)
}

// Heartbeat state shared by tick() and the liveness timer. The timer proves the process is alive
// and its event loop is turning; lastTickTs records tick progress separately, so a long tick (a CI
// poll over a dozen repos can run a minute or more) never makes a live daemon look dead.
let liveTick = 0
let lastTickTs: string | undefined
let startedAtTs: string | undefined

function currentHeartbeat(): Heartbeat {
  return { pid: process.pid, ts: new Date().toISOString(), tick: liveTick, startedAt: startedAtTs, lastTickTs, mode: { reactive: reactiveMode(), auto: autoModeSetting() } }
}

/** One daemon iteration: drain durable intents, poll watchers, run the tick hook, heartbeat. */
export async function tick(n: number, opts: DaemonOptions = {}): Promise<Heartbeat> {
  await drainOutbox() // pending publishes/notifies; safe no-op when the queue is empty
  if (opts.watchGit ?? true) await pollGit(watchedRepos(), gitPollState)
  if ((opts.watchTests ?? true) || (opts.watchCI ?? true)) {
    const deps: ReactiveDeps = { kov: new KovAdapter({ mailRoot: opts.reactiveDeps?.mailRoot }), ...opts.reactiveDeps }
    if (opts.watchTests ?? true) await pollTests(watchedRepos(), testPollState, deps)
    if (opts.watchCI ?? true) {
      await pollCI(watchedRepos(), ciPollState, deps, { pollIntervalMs: opts.ciPollIntervalMs })
    }
  }
  if (opts.onTick) await opts.onTick(n)
  liveTick = n
  lastTickTs = new Date().toISOString()
  const hb = currentHeartbeat()
  writeHeartbeat(hb, opts.heartbeatPath ?? heartbeatPath())
  return hb
}

interface DbOutage {
  lostAt: string
  code: string | null
  message: string
}

/** Events can't be written while the DB is down, so both ends of an outage are recorded once it's
 *  back, carrying the real timestamps. Best-effort: a failure here must never take the loop down. */
async function recordDbOutage(o: DbOutage, failedTicks: number): Promise<void> {
  const restoredAt = new Date().toISOString()
  const downMs = new Date(restoredAt).getTime() - new Date(o.lostAt).getTime()
  console.log(`[daemon] DB connection restored after ~${Math.round(downMs / 1000)}s (${failedTicks} failed tick(s), first error ${o.code ?? 'n/a'})`)
  const payload = { lostAt: o.lostAt, restoredAt, downMs, failedTicks, errorCode: o.code, errorMessage: o.message }
  try {
    await recordEvent({ kind: 'daemon.db.lost', source: 'daemon', payload, dedupKey: `daemon.db.lost:${process.pid}:${o.lostAt}` })
    await recordEvent({ kind: 'daemon.db.restored', source: 'daemon', payload, dedupKey: `daemon.db.restored:${process.pid}:${restoredAt}` })
  } catch (err) {
    console.error('[daemon] could not record DB outage events (non-fatal):', (err as Error).message)
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Run the daemon loop until SIGINT/SIGTERM. */
export async function runDaemon(opts: DaemonOptions = {}): Promise<void> {
  console.log('[daemon] runDaemon entered') // startup trace

  // Single-instance lock FIRST — before touching anything. First-wins: a live
  // incumbent is sacrosanct; we decline and exit 0 without a heartbeat/cluster/reconcile/DB write.
  const lockPath = opts.pidfile ?? pidfilePath()
  const lock = acquireLock(lockPath)
  if (!lock.acquired) {
    console.log(`[daemon] already running, pid ${lock.incumbent} — declining`)
    return
  }
  if (lock.reclaimed) console.log('[daemon] reclaimed a stale pidfile')

  const interval = opts.intervalMs ?? 45_000
  const hbPath = opts.heartbeatPath ?? heartbeatPath()
  let running = true
  const stop = () => {
    running = false
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  // Close the post-reboot persistence gap: bring the cluster up before the DB is needed.
  if (opts.cluster !== false) {
    try {
      const r = await ensureClusterUp(opts.cluster || {})
      if (r.started) console.log('[daemon] brought up the :5433 cluster')
    } catch (err) {
      console.error('[daemon] HALT: postgresql-bion-5433 service unavailable:', (err as Error).message)
      console.error('[daemon] check: Get-Service -Name postgresql-bion-5433 (expect Running/Automatic) — the daemon no longer self-starts a bare instance (race-condition fix), Recovery is the service\'s job now')
      throw err
    }
  }

  const startedAt = new Date().toISOString()
  startedAtTs = startedAt
  liveTick = 0
  lastTickTs = undefined
  await recordEvent({
    kind: 'daemon.start',
    source: 'daemon',
    payload: { pid: process.pid, reactive: reactiveMode(), auto: autoModeSetting() },
    dedupKey: `daemon.start:${process.pid}:${startedAt}`,
  })
  // Ping Forces so a successful launch is observable on the phone, not just in the DB.
  // Durable + at-least-once; dry-run (no ping) when BION_NTFY_URL is unset. Non-fatal on failure.
  await notifyDurably(
    {
      title: 'Bion daemon started',
      message: `daemon up — reactive=${reactiveMode()} auto=${autoModeSetting()} pid=${process.pid}`,
      priority: 3,
      tags: ['bion', 'daemon'],
    },
    `notify:daemon.start:${process.pid}:${startedAt}`,
  ).catch((err) => console.error('[daemon] start-ping failed (non-fatal):', (err as Error).message))
  // On restart, recover any intents left in flight by a prior crash (production posture).
  if (opts.reconcileOnStart ?? true) await reconcile()

  // Liveness timer: writes the heartbeat on its own cadence so it keeps beating through a long tick
  // and while the DB is unreachable. Not unref'd on purpose — it dies with the loop (cleared below).
  const hbTimer = setInterval(() => {
    try {
      writeHeartbeat(currentHeartbeat(), hbPath)
    } catch (err) {
      console.error('[daemon] heartbeat write failed (non-fatal):', (err as Error).message)
    }
  }, opts.heartbeatIntervalMs ?? 15_000)

  let n = 0
  let dbOutage: DbOutage | null = null
  let failures = 0
  while (running) {
    n++
    let delay = interval
    try {
      await tick(n, opts)
      if (dbOutage) {
        await recordDbOutage(dbOutage, failures)
        dbOutage = null
      }
      failures = 0
    } catch (err) {
      failures++
      console.error('[daemon] tick error:', (err as Error).message)
      if (isConnectionError(err)) {
        dbOutage ??= { lostAt: new Date().toISOString(), code: (err as { code?: string }).code ?? null, message: (err as Error).message }
      }
      // A tick error is often the cluster mid-crash-recovery (the service's job, not ours — see
      // cluster.ts) — just check whether it's back yet, best-effort; the next tick retries either way.
      if (opts.cluster !== false) await ensureClusterUp(opts.cluster || {}).catch(() => {})
      // Reconnect backoff: retry at 2s, 4s, 8s, ... capped at the normal interval, instead of
      // waiting a full interval before noticing the DB is back.
      delay = Math.min(interval, 2000 * 2 ** Math.min(failures - 1, 10))
    }
    // sleep in short slices so SIGINT stops promptly
    for (let waited = 0; waited < delay && running; waited += 1000) await sleep(Math.min(1000, delay))
  }
  clearInterval(hbTimer)
  await closePool()
  releaseLock(lockPath) // clean shutdown removes our pidfile (only if still ours)
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
console.log('[daemon] module loaded, isMain=', isMain) // startup trace
if (isMain) {
  // Real daemon: each tick also runs usage check + one Auto Mode step (default shadow: logs, no dispatch).
  const { autoTick } = await import('../auto/autoMode.js')
  runDaemon({ onTick: () => autoTick({}) }).catch((err) => {
    console.error('[daemon] fatal:', err)
    process.exit(1)
  })
}
