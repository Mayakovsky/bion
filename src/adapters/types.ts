import type { Message } from '../core/types.js'

// AgentAdapter — reuses the M6 ChannelIngress shape (dispatch / pollStatus / capabilities).
// Agents are "channels"; they never talk to each other directly, only through Bion (spec §5).

export interface Packet {
  sender: string
  recipient: string
  body: string
  origin: string
  thread?: string
  summary?: string
  type?: string
  /** Mailbox scoping (directive-146/150, FDQ-B2). Omitted → the historical flat shape/NULL. */
  project?: string
}

export interface DispatchResult {
  message: Message
  /** Disk path of the published packet in the recipient's unread/ box. */
  path: string
  /** true if an identical message already existed (dedup_key) — re-dispatch was a no-op. */
  deduped: boolean
}

export interface ConsumedPacket {
  message: Message
  content: string
  path: string
}

export interface FlaggedPacket {
  path: string
  content_sha256: string
  reason: 'no-matching-unconsumed-row'
}

export interface PollResult {
  consumed: ConsumedPacket[]
  flagged: FlaggedPacket[]
}

export interface AgentAdapter {
  readonly id: string
  readonly capabilities: string[]
  readonly wakeMode: 'auto' | 'user_initiated'
  readonly mailRoot: string
  /** Bion routes a packet TO this agent: publish to its mailbox + register in state. */
  dispatch(packet: Packet): Promise<DispatchResult>
  /** This agent reads its inbox; only DB-corroborated packets are returned (routing authority). */
  pollStatus(): Promise<PollResult>
}
