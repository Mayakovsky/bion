import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, releaseLock, pidAlive, runDaemon } from '../src/index.js'

function freshPidPath(): string {
  const dir = join(tmpdir(), `bion-lock-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'daemon.pid')
}
const alive = () => true
const dead = () => false

describe('single-instance lock (directive-15)', () => {
  it('pidAlive: true for self, false for invalid pids', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
  })

  it('cold start (no pidfile): acquires and writes own pid', () => {
    const p = freshPidPath()
    const r = acquireLock(p, dead, 4242)
    expect(r.acquired).toBe(true)
    expect(r.incumbent).toBeUndefined()
    expect(readFileSync(p, 'utf8').trim()).toBe('4242')
  })

  it('live-lock refusal (first-wins): declines and leaves the pidfile untouched', () => {
    const p = freshPidPath()
    writeFileSync(p, '111', 'utf8') // incumbent
    const r = acquireLock(p, alive, 999) // a second launch
    expect(r.acquired).toBe(false)
    expect(r.incumbent).toBe(111)
    expect(readFileSync(p, 'utf8').trim()).toBe('111') // incumbent untouched — NOT newest-wins
  })

  it('stale reclaim: a dead pidfile is reclaimed (crash must not block forever)', () => {
    const p = freshPidPath()
    writeFileSync(p, '222', 'utf8') // stale (dead)
    const r = acquireLock(p, dead, 333)
    expect(r.acquired).toBe(true)
    expect(r.reclaimed).toBe(true)
    expect(readFileSync(p, 'utf8').trim()).toBe('333')
  })

  it('shutdown cleanup: releaseLock removes OUR pidfile, but never an incumbent’s', () => {
    const p = freshPidPath()
    acquireLock(p, dead, 555)
    releaseLock(p, 555)
    expect(existsSync(p)).toBe(false)

    writeFileSync(p, '777', 'utf8') // someone else holds it
    releaseLock(p, 555) // not ours → must not delete
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8').trim()).toBe('777')
  })

  it('runDaemon declines when a live incumbent holds the lock — touches nothing (no heartbeat)', async () => {
    const incumbent = process.ppid // a genuinely-live pid that is NOT this process
    expect(pidAlive(incumbent)).toBe(true)
    const p = freshPidPath()
    writeFileSync(p, String(incumbent), 'utf8')
    const hb = join(tmpdir(), `bion-hb-${randomUUID()}.json`)

    await runDaemon({ pidfile: p, heartbeatPath: hb, cluster: false, watchGit: false })

    expect(existsSync(hb)).toBe(false) // declined before any heartbeat/cluster/DB work
    expect(readFileSync(p, 'utf8').trim()).toBe(String(incumbent)) // incumbent untouched
  })
})
