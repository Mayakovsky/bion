import { recordEvent, type EventResult } from '../core/events.js'
import type { Executor } from '../db/pool.js'

// Desktop-source cost collector (directive-18): the claude.ai Usage endpoint is aggregate/percent
// only (recon Task B — see _internal/COST-RECON-FINDINGS.md) and gives no per-turn signal, so
// Desktop's cost is instead estimated from the size of the text Bion itself already moves through
// the mailbox (ratified fork resolution (b), not the Usage endpoint). Always approximate.

/**
 * Coarse chars->tokens constant (ratified Q2 fallback). There's no client-side access to
 * Anthropic's real tokenizer here; ~4 chars/token is the standard rough-order English-text
 * heuristic. Stated plainly, per directive-18, so it's obvious where the approximation lives.
 */
export const CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}

export interface DesktopMessageCostInput {
  /** Full, untruncated packet body — sizing a summary instead of the body undercounts real cost. */
  body: string
  sender: string
  recipient: string
  triggerClass: string
  /** Stable identifier for this message (the routed `messages.id`) — cost dedup rides on it. */
  messageId: string
}

/**
 * Record an approximate cost event for a message touching the 'desktop' seat, in whichever
 * direction applies: desktop-as-recipient sizes as tokens_in (Desktop reading it), desktop-as-sender
 * sizes as tokens_out (Desktop having written it). No-op (returns null) if neither party is desktop.
 */
export async function recordDesktopCost(input: DesktopMessageCostInput, exec?: Executor): Promise<EventResult | null> {
  const isRecipient = input.recipient === 'desktop'
  const isSender = input.sender === 'desktop'
  if (!isRecipient && !isSender) return null

  const tokens = estimateTokens(input.body)
  return recordEvent(
    {
      kind: 'cost.desktop',
      source: 'desktop-collector',
      dedupKey: `cost.desktop:${input.messageId}`,
      payload: {
        messageId: input.messageId,
        chars: input.body.length,
        sender: input.sender,
        recipient: input.recipient,
      },
      targetSeat: 'desktop',
      triggerClass: input.triggerClass,
      tokensIn: isRecipient ? tokens : 0,
      tokensOut: isSender ? tokens : 0,
      isApproximate: true,
    },
    exec,
  )
}

/**
 * Best-effort wrapper for call sites that must never let a cost-estimate failure block or roll
 * back the actual dispatch (directive-18: "never blocks a dispatch on a missing/failed estimate —
 * degrades to no cost recorded for that event, not a halted turn"). Swallows and logs; callers that
 * want the result back (e.g. tests) should call recordDesktopCost directly instead.
 */
export async function recordDesktopCostSafely(input: DesktopMessageCostInput, exec?: Executor): Promise<void> {
  try {
    await recordDesktopCost(input, exec)
  } catch (err) {
    console.error('[cost] desktop cost estimate failed (dispatch unaffected):', (err as Error).message)
  }
}
