import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectKovCost, query } from '../src/index.js'

function freshRoot(): string {
  return join(tmpdir(), `bion-kov-cost-${randomUUID()}`)
}

function usageLine(opts: {
  requestId: string
  model?: string
  sessionId?: string
  input?: number
  output?: number
  cacheCreate?: number
  cacheRead?: number
}): string {
  return JSON.stringify({
    requestId: opts.requestId,
    message: {
      id: `msg_${opts.requestId}`,
      model: opts.model ?? 'claude-sonnet-5',
      usage: {
        input_tokens: opts.input ?? 10,
        output_tokens: opts.output ?? 20,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
    session_id: opts.sessionId ?? `sess_${randomUUID()}`,
    timestamp: new Date(0).toISOString(),
  })
}

// Gate: the one place a silent bug double-counts real numbers (directive-18 §Section A/5).
describe('kov cost collector — real per-turn tokens from Claude Code JSONL', () => {
  it('dedups duplicate content-block lines sharing one requestId, and a re-scan is a no-op', async () => {
    const root = freshRoot()
    const slug = `C--Users-test-dev-bion-${randomUUID().slice(0, 8)}`
    const projDir = join(root, slug)
    mkdirSync(projDir, { recursive: true })

    const reqId = `req-${randomUUID()}`
    const line = usageLine({ requestId: reqId, input: 100, output: 50, cacheCreate: 10, cacheRead: 5 })
    // Recon-confirmed real-world pattern: one turn emits multiple lines (one per content block),
    // each repeating the same usage block under the same requestId.
    writeFileSync(join(projDir, `${randomUUID()}.jsonl`), [line, line, line].join('\n') + '\n')

    const first = await collectKovCost({ root })
    expect(first.scanned).toBe(1) // 3 lines, 1 distinct turn
    expect(first.recorded).toBe(1)
    expect(first.deduped).toBe(0)

    const rows = await query<{
      tokens_in: number
      tokens_out: number
      model: string
      trigger_class: string
      target_seat: string
      is_approximate: boolean
    }>(
      `SELECT tokens_in, tokens_out, model, trigger_class, target_seat, is_approximate FROM events WHERE dedup_key = $1`,
      [`cost.kov:${reqId}`],
    )
    expect(rows.rows).toHaveLength(1) // not tripled by the 3 duplicate lines
    const row = rows.rows[0]!
    expect(row.tokens_in).toBe(100 + 10 + 5)
    expect(row.tokens_out).toBe(50)
    expect(row.model).toBe('claude-sonnet-5')
    expect(row.trigger_class).toBe(slug)
    expect(row.target_seat).toBe('kov')
    expect(row.is_approximate).toBe(false)

    // Re-running the collector over the SAME files (event-driven, no cursor) must not double-record.
    const second = await collectKovCost({ root })
    expect(second.recorded).toBe(0)
    expect(second.deduped).toBe(1)

    const recount = await query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE dedup_key = $1`, [
      `cost.kov:${reqId}`,
    ])
    expect(recount.rows[0]!.n).toBe('1')
  })

  it('ignores malformed lines and usage-less lines without throwing', async () => {
    const root = freshRoot()
    const slug = `proj-${randomUUID().slice(0, 8)}`
    const projDir = join(root, slug)
    mkdirSync(projDir, { recursive: true })

    const goodReq = `req-${randomUUID()}`
    const good = usageLine({ requestId: goodReq })
    const noUsage = JSON.stringify({ requestId: 'x', message: { id: 'm1' } })
    const garbage = '{not json'
    writeFileSync(join(projDir, `${randomUUID()}.jsonl`), [garbage, noUsage, good, ''].join('\n'))

    const result = await collectKovCost({ root })
    expect(result.scanned).toBe(1)
    expect(result.recorded).toBe(1)
  })

  it('a root with no project logs yields all-zero, no throw', async () => {
    const root = freshRoot() // never created on disk
    const result = await collectKovCost({ root })
    expect(result).toEqual({ scanned: 0, recorded: 0, deduped: 0, skipped: 0 })
  })
})
