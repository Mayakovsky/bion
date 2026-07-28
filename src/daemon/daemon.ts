import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { drainOutbox, reconcile, notifyDurably } from '../db/outbox.js'
import { recordEvent } from '../core/events.js'
import { reactiveMode } from '../loop/reactive.js'
import { closePool } from '../db/pool.js'
import { readGitHead, commitSignal } from '../watchers/gitWatcher.js'
import { handleGitSignal } from '../watchers/handler.js'
import { ensureClusterUp, type EnsureClusterOptions } from './cluster.js'
import { acquireLock, releaseLock, pidfilePath } from './lock.js'
import { heartbeatPath, writeHeartbeat, type Heartbeat } from './heartbeat.js'

// Persistent daemon (Phase E1) — makes Bion a live process so the outbox, watchers, and (later)
// the Auto Mode loop actually run. Local-while-machine-is-up is the accepted posture (B9); the
// scheduled-task-at-logon mechanism (scripts/install-daemon.ps1) restarts it across logout/restart.
//
// SAFE BY DEFAULT: with BION_AUTO_MODE=off it auto-dispatches nothing; with BION_REACTIVE_DISPATCH
// at shadow the reactive path only logs. The tick just drains durable side effects + heartbeats.

export interface DaemonOptions {
  intervalMs?: number
  heartbeatPath?: string
  reconcileOnStart?: boolean
  /** Poll git HEAD each tick and emit a commit signal (live watcher). Default true. */
  watchGit?: boolean
  /** Ensure the :5433 cluster is up on start / after a tick error. false disables (tests). */
  cluster?: EnsureClusterOptions | false
  /** Single-instance pidfile path override (tests isolate this). */
  pidfile?: string
  /** Extension hook (Auto Mode / usage checks are wired in here in E3). */
  onTick?: (tick: number) => Promise<void>
}

function autoMode(): string {
  return (process.env.BION_AUTO_MODE ?? 'off').toLowerCase()
}

// Live git watcher: emit a commit signal when HEAD moves. Idempotent by sha; lastSha avoids a
// DB round-trip every tick.
let lastSha: string | null = null
async function pollGit(cwd: string): Promise<void> {
  try {
    const { branch, sha } = readGitHead(cwd)
    if (sha !== lastSha) {
      await handleGitSignal(commitSignal(branch, sha))
      lastSha = sha
    }
  } catch {
    /* not a git repo / git unavailable — skip */
  }
}

/** One daemon iteration: drain durable intents, poll watchers, run the tick hook, heartbeat. */
export async function tick(n: number, opts: DaemonOptions = {}): Promise<Heartbeat> {
  await drainOutbox() // pending publishes/notifies; safe no-op when the queue is empty
  if (opts.watchGit ?? true) await pollGit(process.cwd())
  if (opts.onTick) await opts.onTick(n)
  const hb: Heartbeat = {
    pid: process.pid,
    ts: new Date().toISOString(),
    tick: n,
    mode: { reactive: reactiveMode(), auto: autoMode() },
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
      console.error('[daemon] HALT: cluster unavailable and could not be started (non-admin):', (err as Error).message)
      console.error('[daemon] prerequisite: the user-owned cluster at BION_PGDATA — run scripts/provision-db.sh or scripts/pg-start.sh')
      throw err
    }
  }

  const startedAt = new Date().toISOString()
  await recordEvent({
    kind: 'daemon.start',
    source: 'daemon',
    payload: { pid: process.pid, reactive: reactiveMode(), auto: autoMode() },
    dedupKey: `daemon.start:${process.pid}:${startedAt}`,
  })
  // Ping Forces so a successful launch is observable on the phone, not just in the DB (directive-11).
  // Durable + at-least-once; dry-run (no ping) when BION_NTFY_URL is unset. Non-fatal on failure.
  await notifyDurably(
    {
      title: 'Bion daemon started',
      message: `daemon up — reactive=${reactiveMode()} auto=${autoMode()} pid=${process.pid}`,
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
      // A tick error is often a cluster that went away mid-run — try to bring it back (best-effort).
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
  // Real daemon: each tick also runs usage check + one Auto Mode step (both default OFF/no-op).
  const { autoTick } = await import('../auto/autoMode.js')
  runDaemon({ onTick: () => autoTick({}) }).catch((err) => {
    console.error('[daemon] fatal:', err)
    process.exit(1)
  })
}
