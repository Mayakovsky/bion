import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { checkHeartbeat, STALE_CONSECUTIVE_CHECKS, STALE_MAX_AGE_MS, STUCK_MAX_AGE_MS } from '../src/cli/checkHeartbeat.js'
import type { NotifyInput } from '../src/notify/ntfy.js'

// Heartbeat ages (seconds) as seen by the real once-a-minute checker on 2026-10-28, 17:00-20:57
// local, copied from .bion/daemon/heartbeat-check.log. That window is the pre-fix stall pattern:
// ticks bloated by the CI poll, heartbeat written only at the end of each tick -> 30 DOWN/recovered
// pairs paged in one day.
const REAL_STALL_AGES_S = [
  37, 5, 19, 79, 25, 40, 8, 22, 36, 96, 39, 7, 21, 35, 95, 41, 10, 24, 38, 52, 112, 13, 27, 42,
  10, 70, 14, 28, 42, 10, 70, 130, 17, 31, 45, 59, 119, 179, 11, 25, 39, 99, 159, 43, 11, 25, 85,
  145, 34, 2, 16, 76, 136, 4, 18, 32, 46, 106, 27, 41, 9, 23, 83, 143, 204, 17, 31, 45, 105, 165,
  27, 41, 9, 69, 129, 17, 31, 45, 60, 120, 180, 31, 45, 59, 119, 179, 239, 299, 43, 103, 5, 19,
  33, 1, 61, 121, 14, 28, 42, 56, 116, 0, 14, 28, 42, 102, 162, 43, 11, 25, 85, 145, 24, 38, 6,
  66, 126, 186, 43, 11, 25, 85, 145, 9, 23, 37, 52, 112, 172, 232, 6, 20, 80, 140, 200, 2, 16,
  76, 76, 196, 3, 17, 31, 91, 151, 26, 39, 7, 67, 127, 187, 13, 27, 41, 101, 161, 38, 6, 20, 80,
  32, 46, 14, 28, 42, 102, 20, 34, 2, 16, 76, 29, 43, 12, 26, 40, 100, 160, 220, 280, 280, 72,
  132, 192, 252, 312, 372, 432, 30, 90, 150, 210, 270, 330, 4, 64, 124, 184, 244, 2, 62, 122,
  182, 242, 302, 46, 106, 166, 1, 16, 30, 90, 36, 4, 18, 33, 47, 107, 9, 23, 38, 6, 66, 126, 43,
  11, 25, 40, 101, 3, 17, 31, 45, 59, 9, 23, 37, 6, 20,
]

/** Drive checkHeartbeat once per age, one simulated minute apart, and return the pushes sent. */
async function replay(agesS: number[]): Promise<NotifyInput[]> {
  const dir = join(tmpdir(), `bion-hbalert-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const hbPath = join(dir, 'heartbeat.json')
  const statePath = join(dir, 'state.json')
  const sent: NotifyInput[] = []
  const notify = async (i: NotifyInput) => (sent.push(i), { sent: true, dryRun: false })
  let now = Date.UTC(2026, 9, 29, 0, 0, 0)
  for (const age of agesS) {
    now += 60_000
    writeFileSync(hbPath, JSON.stringify({ pid: 1, ts: new Date(now - age * 1000).toISOString(), tick: 1, mode: { reactive: 'shadow', auto: 'off' } }))
    await checkHeartbeat({ hbPath, statePath, notify, now, session: noSession })
  }
  return sent
}

/** Probe that fails, i.e. no boot/logon knowledge: the plain threshold rules apply (also what these tests assume). */
const noSession = async () => null

const titles = (sent: NotifyInput[], t: string) => sent.filter((s) => s.title === t).length

describe('heartbeat alert logic against the real 2026-10-28 stall pattern', () => {
  it('baseline: the old policy (120s, page on the first stale reading) paged 25+ pairs on this data', () => {
    let alerted = false
    let pairs = 0
    for (const age of REAL_STALL_AGES_S) {
      const stale = age > 120
      if (stale && !alerted) alerted = true
      else if (!stale && alerted) (alerted = false, pairs++)
    }
    expect(pairs).toBeGreaterThanOrEqual(25)
  })

  it('the new policy pages materially less on the same pre-fix data, and every DOWN is paired', async () => {
    const sent = await replay(REAL_STALL_AGES_S)
    const down = titles(sent, 'Bion daemon DOWN')
    expect(down).toBeLessThan(15)
    expect(Math.abs(down - titles(sent, 'Bion daemon recovered'))).toBeLessThanOrEqual(1)
  })

  it('with the heartbeat on its own 15s timer (post-fix ages, never above ~20s) nothing pages at all', async () => {
    const postFix = REAL_STALL_AGES_S.map((_, i) => 1 + ((i * 7) % 20))
    expect(await replay(postFix)).toHaveLength(0)
  })

  it('a single stale reading is absorbed: no DOWN and no recovered push', async () => {
    expect(await replay([5, 10, STALE_MAX_AGE_MS / 1000 + 60, 8, 12])).toHaveLength(0)
  })

  it('a real outage (heartbeat stops for good) pages once, within a few minutes of the threshold', async () => {
    const dead = Array.from({ length: 30 }, (_, i) => 15 + 60 * (i + 1)) // age grows 1 min per check
    const sent = await replay([5, 10, 8, ...dead])
    expect(titles(sent, 'Bion daemon DOWN')).toBe(1)
    const firstStale = dead.findIndex((a) => a > STALE_MAX_AGE_MS / 1000)
    expect(firstStale + STALE_CONSECUTIVE_CHECKS).toBeLessThanOrEqual(6) // minutes from heartbeat death to page
  })

  it('an outage that then recovers sends exactly one DOWN then one recovered', async () => {
    const sent = await replay([5, 400, 460, 520, 580, 9, 12])
    expect(sent.map((s) => s.title)).toEqual(['Bion daemon DOWN', 'Bion daemon recovered'])
  })
})

// ── STUCK: process alive (heartbeat timer beating) but no tick has finished ──────────────────────

interface Frame {
  /** Seconds since the heartbeat file was last written. */
  age: number
  /** Seconds since the last finished tick; omit for "no tick finished yet". */
  tickAge?: number
  /** Seconds since the process began its loop; omit for a file from an older daemon. */
  startedAge?: number
  tick?: number
}

async function replayFrames(frames: Frame[]): Promise<{ sent: NotifyInput[]; outcomes: string[] }> {
  const dir = join(tmpdir(), `bion-hbstuck-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const hbPath = join(dir, 'heartbeat.json')
  const statePath = join(dir, 'state.json')
  const sent: NotifyInput[] = []
  const outcomes: string[] = []
  const notify = async (i: NotifyInput) => (sent.push(i), { sent: true, dryRun: false })
  let now = Date.UTC(2026, 9, 29, 0, 0, 0)
  for (const f of frames) {
    now += 60_000
    const iso = (ageS: number) => new Date(now - ageS * 1000).toISOString()
    writeFileSync(
      hbPath,
      JSON.stringify({
        pid: 7,
        ts: iso(f.age),
        tick: f.tick ?? 5,
        ...(f.startedAge !== undefined ? { startedAt: iso(f.startedAge) } : {}),
        ...(f.tickAge !== undefined ? { lastTickTs: iso(f.tickAge) } : {}),
        mode: { reactive: 'shadow', auto: 'off' },
      }),
    )
    outcomes.push((await checkHeartbeat({ hbPath, statePath, notify, now, session: noSession })).outcome)
  }
  return { sent, outcomes }
}

const OK = { age: 4, tickAge: 30, startedAge: 3600 }

describe('STUCK alert: process alive, ticks stopped finishing', () => {
  it('fresh heartbeat but stale lastTickTs -> one STUCK after the consecutive checks, then silent', async () => {
    const stuck = { age: 4, tickAge: STUCK_MAX_AGE_MS / 1000 + 120, startedAge: 7200 }
    const { sent, outcomes } = await replayFrames([OK, stuck, stuck, stuck, stuck])
    expect(outcomes).toEqual(['quiet-healthy', 'pending-stuck', 'alerted-stuck', 'quiet-stuck', 'quiet-stuck'])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.title).toBe('Bion daemon STUCK')
    expect(sent[0]!.title).not.toMatch(/DOWN/) // distinguishable from the DOWN alert
    expect(sent[0]!.message).toMatch(/alive/)
    expect(sent[0]!.message).toMatch(/no tick has finished in \d+ min/)
    expect(sent[0]!.message).toMatch(/#5 at \d{4}-/) // last tick number + lastTickTs
  })

  it('a single late tick reading is absorbed (consecutive-check rule), no push either way', async () => {
    const late = { age: 4, tickAge: STUCK_MAX_AGE_MS / 1000 + 30, startedAge: 7200 }
    const { sent } = await replayFrames([OK, late, OK, OK])
    expect(sent).toHaveLength(0)
  })

  it('ticks resuming after STUCK sends exactly one recovered push', async () => {
    const stuck = { age: 4, tickAge: 900, startedAge: 7200 }
    const { sent, outcomes } = await replayFrames([OK, stuck, stuck, stuck, OK, OK])
    expect(sent.map((s) => s.title)).toEqual(['Bion daemon STUCK', 'Bion daemon ticks resumed'])
    expect(outcomes.slice(-2)).toEqual(['alerted-stuck-recovered', 'quiet-healthy'])
  })

  it('a fresh start with no lastTickTs yet is silent while inside the threshold, even on a long first tick', async () => {
    const first = { age: 4, startedAge: 120 } // the ~62 s first CI poll, with margin
    const { sent } = await replayFrames([first, { ...first, startedAge: 180 }, { ...first, startedAge: 400 }, { ...first, startedAge: 560 }])
    expect(sent).toHaveLength(0)
  })

  it('a start that never finishes a first tick does page once the threshold has passed since process start', async () => {
    const wedged = (startedAge: number) => ({ age: 4, startedAge })
    const { sent } = await replayFrames([wedged(300), wedged(660), wedged(720), wedged(780)])
    expect(sent.map((s) => s.title)).toEqual(['Bion daemon STUCK'])
    expect(sent[0]!.message).toMatch(/none since start/)
  })

  it('a heartbeat file from an older daemon (no startedAt, no lastTickTs) is never judged stuck', async () => {
    const { sent } = await replayFrames([{ age: 4 }, { age: 4 }, { age: 4 }])
    expect(sent).toHaveLength(0)
  })

  it('dead process with stale ticks -> DOWN only, never DOWN and STUCK together', async () => {
    const dead = { age: 400, tickAge: 5000, startedAge: 9000 }
    const { sent } = await replayFrames([OK, dead, dead, dead, dead])
    expect(sent.map((s) => s.title)).toEqual(['Bion daemon DOWN'])
  })

  it('STUCK that turns into a dead process -> DOWN, then one recovered, and no spurious "ticks resumed"', async () => {
    const stuck = { age: 4, tickAge: 900, startedAge: 7200 }
    const dead = { age: 400, tickAge: 1300, startedAge: 7600 }
    const restarted = { age: 4, tickAge: 20, startedAge: 60 }
    const { sent } = await replayFrames([OK, stuck, stuck, dead, dead, restarted, restarted])
    expect(sent.map((s) => s.title)).toEqual(['Bion daemon STUCK', 'Bion daemon DOWN', 'Bion daemon recovered'])
  })
})
