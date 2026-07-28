import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Daemon liveness heartbeat — a small file the daemon rewrites each tick so `bion status`
// (and anything else) can tell whether Bion is running and how fresh it is.

export interface Heartbeat {
  pid: number
  ts: string
  tick: number
  mode: { reactive: string; auto: string }
}

export function heartbeatPath(root?: string): string {
  return root ?? join(process.cwd(), '.bion', 'daemon', 'heartbeat.json')
}

export function writeHeartbeat(hb: Heartbeat, path = heartbeatPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(hb, null, 2), 'utf8')
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
