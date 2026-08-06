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
 * Ensure the cluster is reachable: probe first; if down, wait with backoff for it to come back.
 * Throws only if the cluster never becomes reachable, which the daemon treats as a HALT.
 *
 * Does NOT self-start a bare `pg_ctl` process by default (BION-POSTGRES-SERVICE-REGISTRATION-KOV
 * race-condition fix, 2026-08-06). Bion's cluster is now a supervised Windows Service
 * (`postgresql-bion-5433`, Automatic startup + Recovery-on-crash) — a daemon-launched bare
 * instance would compete with it for port 5433, exactly the race demonstrated during that
 * directive's own deliberate-kill proof (killing the service's process caused THIS function's old
 * default to win the race and grab the port before the service's own Recovery could rebind it).
 * Recovery is the service's job now, not the daemon's; this function only waits for it. Pass an
 * explicit `start` (e.g. `startCluster`, still exported below) to opt back into self-starting —
 * useful for local dev without the service installed, never the default for the real daemon.
 */
export async function ensureClusterUp(opts: EnsureClusterOptions = {}): Promise<{ started: boolean }> {
  const probe = opts.probe ?? (() => canConnect())
  const start = opts.start // no default — see above
  if (await probe()) return { started: false }

  let startError: Error | undefined
  if (start) {
    try {
      start()
    } catch (err) {
      startError = err as Error
    }
  }

  const retries = opts.retries ?? 12
  const backoffMs = opts.backoffMs ?? 500
  for (let i = 0; i < retries; i++) {
    await sleep(backoffMs)
    if (await probe()) return { started: true }
  }
  throw new Error(
    `cluster did not become reachable${start ? ' after a start attempt' : ' (waiting for the postgresql-bion-5433 service, not self-starting)'}${startError ? ` (start error: ${startError.message})` : ''}`,
  )
}
