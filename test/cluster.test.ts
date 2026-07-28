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
})
