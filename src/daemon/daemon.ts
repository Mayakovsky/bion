import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { drainOutbox, reconcile, notifyDurably } from '../db/outbox.js'
import { recordEvent } from '../core/events.js'
import { reactiveMode } from '../loop/reactive.js'
import { autoModeSetting } from '../auto/autoMode.js'
import { closePool } from '../db/pool.js'
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

// Persistent daemon (Phase E1) — makes Bion a live process so the outbox, watchers, and (later)
// the Auto Mode loop actually run. Local-while-machine-is-up is the accepted posture (B9); the
// scheduled-task-at-logon mechanism (scripts/install-daemon.ps1) restarts it across logout/restart.
//
// SAFE BY DEFAULT: with BION_AUTO_MODE unset/shadow (directive-20) it logs would-dispatch and fires
// nothing; with BION_REACTIVE_DISPATCH at shadow the reactive path only logs. The tick just drains
// durable side effects + heartbeats.

export interface DaemonOptions {
  intervalMs?: number
  heartbeatPath?: string
  reconcileOnStart?: boolean
  /** Poll git HEAD each tick and emit a commit signal (live watcher). Default true. */
  watchGit?: boolean
  /** Poll for vitest JSON result files each tick and emit a test signal (live watcher,
   *  directive-27 Task 2). Default true. */
  watchTests?: boolean
  /** Poll GitHub Actions for each watched repo's CI runs (rate-limited internally, not every
   *  tick — directive-128). Default true. */
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
// repo; gitPollState avoids a DB round-trip every tick. Dev-root-wide auto-discovery (directive-68,
// replaces directive-27's bion+GREY_REPO_PATH static list): every repo discoverRepos() finds under
// env.devRoot, re-discovered each tick so a repo added mid-run is picked up without a restart.
const gitPollState = createGitPollState()
const testPollState = createTestPollState()
const ciPollState = createCIPollState()
function watchedRepos(): RepoRef[] {
  return discoverRepos(env.devRoot)
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
  const hb: Heartbeat = {
    pid: process.pid,
    ts: new Date().toISOString(),
    tick: n,
    mode: { reactive: reactiveMode(), auto: autoModeSetting() },
  }
  writeHeartbeat(hb, opts.heartbeatPath ?? heartbeatPath())
  return hb
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Run the daemon loop until SIGINT/SIGTERM. */
export async function runDaemon(opts: DaemonOptions = {}): Promise<void> {
  console.log('[daemon] runDaemon entered') // directive-13 step-1 trace

  // Single-instance lock (directive-15) FIRST — before touching anything. First-wins: a live
  // incumbent is sacrosanct; we decline and exit 0 without a heartbeat/cluster/reconcile/DB write.
  const lockPath = opts.pidfile ?? pidfilePath()
  const lock = acquireLock(lockPath)
  if (!lock.acquired) {
    console.log(`[daemon] already running, pid ${lock.incumbent} — declining`)
    return
  }
  if (lock.reclaimed) console.log('[daemon] reclaimed a stale pidfile')

  const interval = opts.intervalMs ?? 45_000
  let running = true
  const stop = () => {
    running = false
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  // Close the post-reboot persistence gap: bring the cluster up before the DB is needed (directive-08).
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
  await recordEvent({
    kind: 'daemon.start',
    source: 'daemon',
    payload: { pid: process.pid, reactive: reactiveMode(), auto: autoModeSetting() },
    dedupKey: `daemon.start:${process.pid}:${startedAt}`,
  })
  // Ping Forces so a successful launch is observable on the phone, not just in the DB (directive-11).
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

  let n = 0
  while (running) {
    n++
    try {
      await tick(n, opts)
    } catch (err) {
      console.error('[daemon] tick error:', (err as Error).message)
      // A tick error is often the cluster mid-crash-recovery (the service's job, not ours — see
      // cluster.ts) — just check whether it's back yet, best-effort; the next tick retries either way.
      if (opts.cluster !== false) await ensureClusterUp(opts.cluster || {}).catch(() => {})
    }
    // sleep in short slices so SIGINT stops promptly
    for (let waited = 0; waited < interval && running; waited += 1000) await sleep(Math.min(1000, interval))
  }
  await closePool()
  releaseLock(lockPath) // clean shutdown removes our pidfile (only if still ours)
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
console.log('[daemon] module loaded, isMain=', isMain) // directive-13 step-1 trace
if (isMain) {
  // Real daemon: each tick also runs usage check + one Auto Mode step (default shadow: logs, no dispatch).
  const { autoTick } = await import('../auto/autoMode.js')
  runDaemon({ onTick: () => autoTick({}) }).catch((err) => {
    console.error('[daemon] fatal:', err)
    process.exit(1)
  })
}
