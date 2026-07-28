import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { repoPath } from '../paths.js'

// Single-instance lock (directive-15) — first-wins, machine-local pidfile. A second launch NEVER
// kills the incumbent: it declines and exits. A stale pidfile (dead pid) is reclaimed so a crash
// can't block every future start. This is a correctness (one heartbeat writer) + cost (no
// double-dispatch under autonomy) guarantee. It guards ONE machine only — cross-host coordination
// against a shared DB is a DB advisory lock, out of scope here (see FDQ-B15).

export function pidfilePath(path?: string): string {
  return path ?? repoPath('.bion', 'daemon', 'daemon.pid')
}

/** Robust-on-Windows liveness: process-exists via signal 0 (EPERM = exists but not ours = alive). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface LockResult {
  acquired: boolean
  /** Set when declined: the live pid that holds the lock. */
  incumbent?: number
  /** Set when a stale pidfile was reclaimed. */
  reclaimed?: boolean
}

/**
 * Try to acquire the machine-local lock. First-wins: if the pidfile holds a LIVE pid, decline
 * (leaving it untouched). If it's stale or missing, write our pid and proceed.
 */
export function acquireLock(
  path: string = pidfilePath(),
  aliveCheck: (pid: number) => boolean = pidAlive,
  selfPid: number = process.pid,
): LockResult {
  if (existsSync(path)) {
    const held = Number(readFileSync(path, 'utf8').trim().split(/\s+/)[0])
    if (Number.isInteger(held) && held !== selfPid && aliveCheck(held)) {
      return { acquired: false, incumbent: held } // incumbent is sacrosanct — do not touch
    }
    // stale (dead) or already ours → reclaim
    writeOwn(path, selfPid)
    return { acquired: true, reclaimed: held !== selfPid }
  }
  writeOwn(path, selfPid)
  return { acquired: true }
}

/** Release the lock on clean shutdown — but ONLY if it is still ours (never delete an incumbent's). */
export function releaseLock(path: string = pidfilePath(), selfPid: number = process.pid): void {
  try {
    if (!existsSync(path)) return
    const held = Number(readFileSync(path, 'utf8').trim().split(/\s+/)[0])
    if (held === selfPid) rmSync(path)
  } catch {
    /* best-effort */
  }
}

function writeOwn(path: string, selfPid: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, String(selfPid), 'utf8')
}
