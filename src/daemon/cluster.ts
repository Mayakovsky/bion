import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import pg from 'pg'
import { env } from '../env.js'

// Cluster autostart (directive-08) — the daemon ensures the dedicated :5433 cluster is up before it
// needs it, so a single logon task (BionDaemon) is sufficient: no cross-task ordering. Starting the
// user-owned cluster is NON-ADMIN (pg_ctl on the user's own data dir).

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const PGBIN = process.env.BION_PGBIN ?? 'C:\\Program Files\\PostgreSQL\\16\\bin'
const PGDATA = process.env.BION_PGDATA ?? join(HOME, '.bion-pg', 'data')
const LOGFILE = join(HOME, '.bion-pg', 'server.log')

function pgPort(): string {
  try {
    return new URL(env.databaseUrl).port || '5432'
  } catch {
    return '5432'
  }
}

/** Quick connectivity probe against the runtime URL. */
export async function canConnect(timeoutMs = 1500): Promise<boolean> {
  const client = new pg.Client({ connectionString: env.databaseUrl, connectionTimeoutMillis: timeoutMs })
  try {
    await client.connect()
    await client.end()
    return true
  } catch {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
    return false
  }
}

/** Start the user-owned cluster via pg_ctl (non-admin). Throws if pg_ctl/data dir is unavailable. */
export function startCluster(): void {
  execFileSync(
    join(PGBIN, 'pg_ctl.exe'),
    ['-D', PGDATA, '-l', LOGFILE, '-o', `-p ${pgPort()} -c listen_addresses=127.0.0.1`, 'start'],
    { stdio: 'ignore', timeout: 20_000 },
  )
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface EnsureClusterOptions {
  retries?: number
  backoffMs?: number
  probe?: () => Promise<boolean>
  start?: () => void
}

/**
 * Ensure the cluster is reachable: probe first; if down, start it and re-probe with backoff. A
 * start() error is not fatal on its own (e.g. "already running") — success is decided by the probe.
 * Throws only if the cluster never becomes reachable, which the daemon treats as a HALT.
 */
export async function ensureClusterUp(opts: EnsureClusterOptions = {}): Promise<{ started: boolean }> {
  const probe = opts.probe ?? (() => canConnect())
  const start = opts.start ?? startCluster
  if (await probe()) return { started: false }

  let startError: Error | undefined
  try {
    start()
  } catch (err) {
    startError = err as Error
  }

  const retries = opts.retries ?? 12
  const backoffMs = opts.backoffMs ?? 500
  for (let i = 0; i < retries; i++) {
    await sleep(backoffMs)
    if (await probe()) return { started: true }
  }
  throw new Error(
    `cluster did not become reachable after a start attempt${startError ? ` (start error: ${startError.message})` : ''}`,
  )
}
