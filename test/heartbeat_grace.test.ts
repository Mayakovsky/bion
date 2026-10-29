import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { checkHeartbeat, LOGON_GRACE_MS, STALE_MAX_AGE_MS, type SessionInfo } from '../src/cli/checkHeartbeat.js'
import type { NotifyInput } from '../src/notify/ntfy.js'

// Boot/logon-aware grace: the PC is shut down nightly and the daemon only launches at interactive
// logon, so the previous night's heartbeat is stale at every first boot. That must not page — but a
// daemon that does not come up after logon, or dies at logoff, still must.

const L = (iso: string) => Date.parse(`${iso}-06:00`) // box-local (UTC-6) wall time -> epoch ms

interface Beat {
  /** Wall time of the check. */
  at: number
  /** When the daemon last beat, as of that check (null = no heartbeat file). */
  hbAt: number | null
  startedAt?: number
  lastTickAt?: number
}

type Sent = NotifyInput & { at: number }

/** Replay absolute-time checks. `sessionAt(now)` is what the machine would have answered at that moment. */
async function replayMorning(
  beats: Beat[],
  sessionAt: (now: number) => SessionInfo | null,
  seedState?: Record<string, unknown>,
): Promise<{ sent: Sent[]; outcomes: string[]; finalState: Record<string, unknown> }> {
  const dir = join(tmpdir(), `bion-hbmorning-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const hbPath = join(dir, 'heartbeat.json')
  const statePath = join(dir, 'state.json')
  if (seedState) writeFileSync(statePath, JSON.stringify(seedState))
  const sent: Sent[] = []
  const outcomes: string[] = []
  let at = 0
  const notify = async (i: NotifyInput) => (sent.push({ ...i, at }), { sent: true, dryRun: false })
  for (const b of beats) {
    at = b.at
    if (b.hbAt !== null) {
      writeFileSync(
        hbPath,
        JSON.stringify({
          pid: 9,
          ts: new Date(b.hbAt).toISOString(),
          tick: 3,
          ...(b.startedAt !== undefined ? { startedAt: new Date(b.startedAt).toISOString() } : {}),
          ...(b.lastTickAt !== undefined ? { lastTickTs: new Date(b.lastTickAt).toISOString() } : {}),
          mode: { reactive: 'shadow', auto: 'off' },
        }),
      )
    }
    const r = await checkHeartbeat({ hbPath, statePath, notify, now: b.at, session: async () => sessionAt(b.at) })
    outcomes.push(r.outcome)
  }
  return { sent, outcomes, finalState: existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {} }
}

// The real 2026-10-28 morning, from .bion/daemon/heartbeat-check.log: shutdown 10-27 18:59, boot 08:23:09,
// interactive logon (explorer.exe) 08:28:17, daemon launched 08:28:17 and first beat ~08:30. The checker ran
// each minute at :12; each age below is exactly what it logged.
const BOOT = L('2026-10-28T08:23:09')
const LOGON = L('2026-10-28T08:28:17')
const sessionAt = (now: number): SessionInfo => ({ bootMs: BOOT, logonMs: now >= LOGON ? LOGON : null })
const REAL_MORNING: Array<[string, number]> = [
  ['08:24:12', 52101], ['08:25:12', 52160], ['08:26:12', 52220], ['08:27:12', 52280], ['08:28:12', 52340],
  ['08:29:12', 52400], ['08:30:12', 32], ['08:31:12', 0], ['08:32:12', 14], ['08:33:12', 29], ['08:34:12', 89], ['08:35:12', 31],
]
const realBeats = (): Beat[] =>
  REAL_MORNING.map(([t, ageS]) => {
    const at = L(`2026-10-28T${t}`)
    return { at, hbAt: at - ageS * 1000, ...(ageS < 600 ? { startedAt: LOGON } : {}) }
  })

const titles = (sent: Sent[]) => sent.map((s) => s.title)

describe('boot/logon-aware grace: no morning pair, but a daemon that never comes up still pages', () => {
  it('baseline: without boot/logon knowledge the real morning pages a DOWN and a recovered (what Forces gets today)', async () => {
    const { sent } = await replayMorning(realBeats(), () => null)
    expect(titles(sent)).toEqual(['Bion daemon DOWN', 'Bion daemon recovered'])
  })

  it('the real 10-28 morning with boot/logon awareness sends zero pushes', async () => {
    const { sent, outcomes } = await replayMorning(realBeats(), sessionAt)
    expect(sent).toEqual([])
    expect(outcomes.slice(0, 4)).toEqual(Array(4).fill('quiet-prelogon')) // 08:24-08:27, nobody logged in yet
    expect(outcomes).toContain('quiet-grace') // 08:28-08:29, logged in, daemon launching
    expect(outcomes.slice(-3)).toEqual(Array(3).fill('quiet-healthy'))
  })

  it('logon but the daemon never starts: exactly one DOWN, after grace + threshold, saying it failed to come up', async () => {
    const beats: Beat[] = []
    for (let m = 24; m <= 59; m++) {
      beats.push({ at: L(`2026-10-28T08:${String(m).padStart(2, '0')}:12`), hbAt: L('2026-10-27T18:58:40') }) // last night's final beat
    }
    const { sent } = await replayMorning(beats, sessionAt)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.title).toBe('Bion daemon DOWN')
    expect(sent[0]!.message).toMatch(/failed to come up after logon/)
    expect(sent[0]!.message).not.toMatch(/stale \(\d{5}s/) // not the "heartbeat stale (50000s)" wording
    const graceEnd = LOGON + LOGON_GRACE_MS
    expect(sent[0]!.at).toBeGreaterThan(graceEnd + STALE_MAX_AGE_MS) // never inside grace or the threshold after it
    expect(sent[0]!.at).toBeLessThanOrEqual(graceEnd + STALE_MAX_AGE_MS + 4 * 60_000) // plus 2 consecutive 1-min checks
  })

  it('state left over from before the shutdown (alerted:true) yields no orphan "recovered" on a clean morning', async () => {
    const wrote = new Date(L('2026-10-27T18:55:00')).toISOString()
    const { sent, finalState } = await replayMorning(realBeats(), sessionAt, { alerted: true, since: wrote, updatedAt: wrote })
    expect(sent).toEqual([])
    expect(finalState.alerted).toBe(false)
  })

  it('a stale streak carried across the shutdown does not make the first morning check page', async () => {
    const seed = { alerted: false, staleStreak: 1, updatedAt: new Date(L('2026-10-27T18:59:00')).toISOString() }
    const { sent, outcomes } = await replayMorning([{ at: L('2026-10-28T08:24:12'), hbAt: L('2026-10-27T18:58:40') }], sessionAt, seed)
    expect(sent).toEqual([])
    expect(outcomes).toEqual(['quiet-prelogon'])
  })

  it('booted but nobody ever logs in: silent for hours (no daemon can be running)', async () => {
    const beats: Beat[] = []
    for (let m = 1; m <= 120; m++) beats.push({ at: BOOT + m * 60_000, hbAt: L('2026-10-27T18:58:40') })
    const { sent } = await replayMorning(beats, () => ({ bootMs: BOOT, logonMs: null }))
    expect(sent).toEqual([])
  })

  it('logoff mid-day (daemon beat this boot, session now gone) is still a real DOWN', async () => {
    const lastBeat = L('2026-10-28T14:00:00')
    const beats: Beat[] = []
    for (let m = 1; m <= 12; m++) beats.push({ at: lastBeat + m * 60_000, hbAt: lastBeat })
    const { sent } = await replayMorning(beats, () => ({ bootMs: BOOT, logonMs: null }))
    expect(titles(sent)).toEqual(['Bion daemon DOWN'])
    expect(sent[0]!.message).toMatch(/heartbeat stale/)
  })

  it('a DOWN paged THIS boot still gets its recovered push when the daemon comes back', async () => {
    const lastBeat = L('2026-10-28T14:00:00')
    const relogon = lastBeat + 9 * 60_000 - 90_000
    const beats: Beat[] = []
    for (let m = 1; m <= 8; m++) beats.push({ at: lastBeat + m * 60_000, hbAt: lastBeat })
    const back = lastBeat + 9 * 60_000
    beats.push({ at: back, hbAt: back - 5000, startedAt: back - 60_000 })
    const { sent } = await replayMorning(beats, (now) => ({ bootMs: BOOT, logonMs: now >= relogon ? relogon : null }))
    expect(titles(sent)).toEqual(['Bion daemon DOWN', 'Bion daemon recovered'])
  })

  it('a fresh start whose first tick runs long stays silent through the grace window (no STUCK)', async () => {
    const beats: Beat[] = []
    for (let m = 1; m <= 8; m++) {
      const at = LOGON + m * 60_000
      beats.push({ at, hbAt: at - 3000, startedAt: LOGON + 5_000 }) // beating, first tick still running
    }
    const { sent } = await replayMorning(beats, sessionAt)
    expect(sent).toEqual([])
  })

  it('if the probe itself fails the plain rules apply: a stale heartbeat still pages (never quieter)', async () => {
    const beats: Beat[] = []
    for (let m = 24; m <= 30; m++) beats.push({ at: L(`2026-10-28T08:${m}:12`), hbAt: L('2026-10-27T18:58:40') })
    const { sent } = await replayMorning(beats, () => null)
    expect(titles(sent)).toEqual(['Bion daemon DOWN'])
  })
})
