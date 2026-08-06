import { describe, it, expect } from 'vitest'
import { ensureClusterUp } from '../src/index.js'

// directive-08: the daemon ensures the cluster is up. Unit-tested with injected probe/start so the
// real cluster is never touched (other specs need it live).
describe('ensureClusterUp (cluster autostart)', () => {
  it('no-ops when the cluster is already reachable', async () => {
    let started = 0
    const r = await ensureClusterUp({ probe: async () => true, start: () => { started++ } })
    expect(r).toEqual({ started: false })
    expect(started).toBe(0) // never tried to start an already-up cluster
  })

  it('starts the cluster when down, then succeeds once it becomes reachable', async () => {
    let started = 0
    let probes = 0
    const r = await ensureClusterUp({
      backoffMs: 1,
      probe: async () => (probes++ === 0 ? false : true), // down first, up after start
      start: () => { started++ },
    })
    expect(started).toBe(1)
    expect(r).toEqual({ started: true })
  })

  it('throws (HALT) if the cluster never becomes reachable', async () => {
    await expect(
      ensureClusterUp({ retries: 3, backoffMs: 1, probe: async () => false, start: () => {} }),
    ).rejects.toThrow(/did not become reachable/)
  })

  it('a start() error is not fatal if the probe later passes', async () => {
    let probes = 0
    const r = await ensureClusterUp({
      backoffMs: 1,
      probe: async () => probes++ >= 1, // false once, then true
      start: () => { throw new Error('already running') },
    })
    expect(r).toEqual({ started: true })
  })

  // Race-condition fix (BION-POSTGRES-SERVICE-REGISTRATION-KOV, 2026-08-06): Bion's cluster is a
  // supervised Windows Service now — ensureClusterUp must NOT self-start a bare process by
  // default, or it races the service's own Recovery for port 5433 (demonstrated live during that
  // directive's deliberate-kill proof). No `start` option here at all — this must not throw
  // "start is not a function" or otherwise attempt to invoke anything.
  it('does NOT self-start when no start() is provided — waits, then throws cleanly if still down', async () => {
    await expect(
      ensureClusterUp({ retries: 2, backoffMs: 1, probe: async () => false }),
    ).rejects.toThrow(/did not become reachable/)
  })

  it('does NOT self-start when no start() is provided — succeeds if the service comes back on its own', async () => {
    let probes = 0
    const r = await ensureClusterUp({
      backoffMs: 1,
      probe: async () => (probes++ === 0 ? false : true), // down first, up on its own (no start call)
    })
    expect(r).toEqual({ started: true })
  })
})
