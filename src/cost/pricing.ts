// Model pricing table (directive-18 §Section A/3). $ per million tokens.
//
// PLACEHOLDER RATES — matched by family keyword (opus/sonnet/haiku), not exact model string,
// because list pricing moves and Bion shouldn't need a code change for every point release.
// These numbers are NOT pulled from a live rate card; Forces should confirm/update them against
// the actual published Anthropic pricing before `bion cost` dollar figures are treated as
// decision-grade. Token counts (what actually drives these dollars) are real either way —
// see kovCollector.ts — this table only converts real tokens into an estimated dollar figure.
export interface ModelRate {
  /** $ per 1,000,000 tokens. */
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

const FAMILY_RATES: Array<{ match: RegExp; rate: ModelRate }> = [
  { match: /opus/i, rate: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { match: /sonnet/i, rate: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { match: /haiku/i, rate: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 } },
]

/** Rate lookup for an unrecognized model family — conservative (sonnet-tier), flagged via null return upstream. */
const FALLBACK_RATE: ModelRate = FAMILY_RATES[1]!.rate

export function rateFor(model: string): ModelRate {
  const hit = FAMILY_RATES.find((f) => f.match.test(model))
  return hit ? hit.rate : FALLBACK_RATE
}

export function isKnownModel(model: string): boolean {
  return FAMILY_RATES.some((f) => f.match.test(model))
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

/** Estimate USD cost for one turn's token usage against a model's rate. */
export function estimateCost(model: string, usage: TokenUsage): number {
  const r = rateFor(model)
  return (
    (usage.inputTokens * r.input +
      usage.outputTokens * r.output +
      usage.cacheCreationTokens * r.cacheWrite +
      usage.cacheReadTokens * r.cacheRead) /
    1_000_000
  )
}
