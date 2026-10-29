import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { repoPath } from '../paths.js'

// Daemon liveness heartbeat — a small file the daemon rewrites on its own timer (daemon.ts) so
// `bion status` and `bion check-heartbeat` can tell whether the PROCESS is alive and its event loop
// turning. It deliberately does not wait on a tick: a slow tick (e.g. a long CI poll) must not make
// a live daemon look dead. `lastTickTs` carries tick progress separately.

export interface Heartbeat {
  pid: number
  ts: string
  tick: number
  /** When the most recent tick finished — absent until the first tick completes. */
  lastTickTs?: string
  mode: { reactive: string; auto: string }
}

export function heartbeatPath(root?: string): string {
  return root ?? repoPath('.bion', 'daemon', 'heartbeat.json')
}

export function writeHeartbeat(hb: Heartbeat, path = heartbeatPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  // Write-then-rename so a concurrent reader (the once-a-minute checker) never sees a half-written
  // file, which readHeartbeat would treat as "no heartbeat" and read as dead.
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(hb, null, 2), 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    writeFileSync(path, JSON.stringify(hb, null, 2), 'utf8') // rename can lose a Windows file-lock race
  }
}

export function readHeartbeat(path = heartbeatPath()): Heartbeat | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Heartbeat
  } catch {
    return null
  }
}

/** A daemon is "alive" if its heartbeat exists and is fresher than maxAgeMs. */
export function isDaemonAlive(path = heartbeatPath(), maxAgeMs = 120_000, now = Date.now()): boolean {
  const hb = readHeartbeat(path)
  if (!hb) return false
  return now - new Date(hb.ts).getTime() <= maxAgeMs
}
