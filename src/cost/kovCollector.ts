import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { Executor } from '../db/pool.js'
import { recordEvent } from '../core/events.js'
import { estimateCost } from './pricing.js'

// Kov-source cost collector (directive-18 §Section A/3): Bion's REAL cost source (recon confirmed
// exact per-turn token counts, not an estimate — see _internal/COST-RECON-FINDINGS.md Task A).
//
// Reads Claude Code CLI's own local session logs directly — no ccusage dependency, since all we
// need is the same JSONL Claude Code already writes. Runs on-demand (event-driven, Q1: no timer).
//
// Known tradeoff: this does a full rescan of every session file on each call. Correctness doesn't
// depend on incremental reads — recordEvent's dedup_key (cost.kov:<requestId>) makes a rescan of
// an already-recorded line a DB-level no-op — but it does mean cost scales with total log volume,
// not just what's new since the last call. Acceptable for a measurement-only, event-driven module;
// revisit with a per-file high-water mark if scan time becomes a problem in practice.

export function defaultClaudeProjectsRoot(): string {
  return process.env.BION_CLAUDE_PROJECTS_ROOT ?? join(homedir(), '.claude', 'projects')
}

function listJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(root)
  return out
}

interface UsageRecord {
  requestId: string
  model: string
  sessionId: string
  timestamp: string
  projectSlug: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

/** Non-negative finite number, else 0 — a malformed/negative field never poisons the sum. */
function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function parseLine(line: string, projectSlug: string): UsageRecord | null {
  if (!line.trim()) return null
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const rec = obj as Record<string, unknown>
  const message = rec.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, unknown> | undefined
  if (!usage || typeof usage !== 'object') return null

  // Claude Code emits one line per content-block; a single turn's usage repeats across lines
  // sharing one requestId/message.id (recon-confirmed). Key on that so callers can dedup in-memory
  // AND rely on recordEvent's dedup_key as a DB-level backstop across repeated scans.
  const requestId = rec.requestId ?? message?.id
  if (typeof requestId !== 'string' || !requestId) return null

  return {
    requestId,
    model: typeof message?.model === 'string' ? message.model : 'unknown',
    sessionId:
      typeof rec.session_id === 'string' ? rec.session_id : typeof rec.sessionId === 'string' ? rec.sessionId : 'unknown',
    timestamp: typeof rec.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString(),
    projectSlug,
    inputTokens: numOr0(usage.input_tokens),
    outputTokens: numOr0(usage.output_tokens),
    cacheCreationTokens: numOr0(usage.cache_creation_input_tokens),
    cacheReadTokens: numOr0(usage.cache_read_input_tokens),
  }
}

export interface CollectKovCostResult {
  /** Distinct turns found across all scanned files (post in-memory dedup by requestId). */
  scanned: number
  /** New cost.kov events actually inserted. */
  recorded: number
  /** Already-recorded turns (dedup_key hit — a prior scan, or a re-run). */
  deduped: number
  /** Files that could not be read (permissions, mid-write, etc.) — skipped, not fatal. */
  skipped: number
}

/**
 * Parse ~/.claude/projects/**\/*.jsonl and record one cost.kov event per distinct turn
 * (target_seat='kov', is_approximate=false — recon confirmed these are real token counts).
 * trigger_class is the Claude Code project-folder slug (e.g. `C--Users-kidco-dev-bion-repo`) —
 * the only "why" signal a plain session log actually gives us, not an invented category.
 */
export async function collectKovCost(deps: { root?: string; exec?: Executor } = {}): Promise<CollectKovCostResult> {
  const root = deps.root ?? defaultClaudeProjectsRoot()
  const files = listJsonlFiles(root)

  const seen = new Map<string, UsageRecord>()
  let skipped = 0

  for (const file of files) {
    const projectSlug = relative(root, file).split(sep)[0] || 'unknown'
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      skipped++
      continue
    }
    for (const line of content.split('\n')) {
      const rec = parseLine(line, projectSlug)
      if (rec && !seen.has(rec.requestId)) seen.set(rec.requestId, rec)
    }
  }

  let recorded = 0
  let deduped = 0
  for (const rec of seen.values()) {
    const usage = {
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      cacheCreationTokens: rec.cacheCreationTokens,
      cacheReadTokens: rec.cacheReadTokens,
    }
    const { deduped: wasDup } = await recordEvent(
      {
        kind: 'cost.kov',
        source: 'kov-collector',
        dedupKey: `cost.kov:${rec.requestId}`,
        payload: { requestId: rec.requestId, sessionId: rec.sessionId, timestamp: rec.timestamp, ...usage },
        targetSeat: 'kov',
        triggerClass: rec.projectSlug,
        model: rec.model,
        tokensIn: usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens,
        tokensOut: usage.outputTokens,
        estCost: estimateCost(rec.model, usage),
        isApproximate: false,
      },
      deps.exec,
    )
    if (wasDup) deduped++
    else recorded++
  }

  return { scanned: seen.size, recorded, deduped, skipped }
}
