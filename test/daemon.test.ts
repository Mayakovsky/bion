import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tick, readHeartbeat, isDaemonAlive } from '../src/index.js'

const hbPath = () => join(tmpdir(), `bion-hb-${randomUUID()}.json`)

describe('daemon tick + heartbeat (E1)', () => {
  it('a tick drains durable intents and writes a fresh heartbeat', async () => {
    const path = hbPath()
    const hb = await tick(7, { heartbeatPath: path, watchGit: false })
    expect(hb.tick).toBe(7)
    expect(hb.pid).toBe(process.pid)
    expect(hb.mode).toHaveProperty('reactive')
    expect(hb.mode).toHaveProperty('auto')
    expect(existsSync(path)).toBe(true)
    expect(readHeartbeat(path)!.tick).toBe(7)
  })

  it('the onTick hook runs (Auto Mode / usage wire in here)', async () => {
    const path = hbPath()
    let ran = 0
    await tick(1, { heartbeatPath: path, watchGit: false, onTick: async () => { ran++ } })
    expect(ran).toBe(1)
  })

  it('isDaemonAlive reflects heartbeat freshness', async () => {
    const path = hbPath()
    const hb = await tick(1, { heartbeatPath: path, watchGit: false })
    const t = new Date(hb.ts).getTime()
    expect(isDaemonAlive(path, 120_000, t + 10_000)).toBe(true) // 10s old < 120s
    expect(isDaemonAlive(path, 120_000, t + 200_000)).toBe(false) // 200s old > 120s
    expect(isDaemonAlive(join(tmpdir(), `missing-${randomUUID()}.json`))).toBe(false)
  })
})
