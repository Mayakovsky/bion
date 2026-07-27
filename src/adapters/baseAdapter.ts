import { sha256 } from '../core/ids.js'
import { recordEvent } from '../core/events.js'
import { consume, findUnconsumedByHash } from '../core/consumption.js'
import { routePacket } from '../core/routing.js'
import { drainOutbox } from '../db/outbox.js'
import { listBox, movePacket, readPacket } from '../mailbox/mailbox.js'
import type { AgentAdapter, DispatchResult, Packet, PollResult } from './types.js'

export interface BaseAdapterOptions {
  id: string
  capabilities: string[]
  wakeMode: 'auto' | 'user_initiated'
  /** Mailbox root override (tests isolate this). Defaults to BION_MAIL_ROOT / cwd/.bion/mail. */
  mailRoot?: string
}

/**
 * Shared adapter behaviour. dispatch() publishes to the agent's mailbox and registers the
 * message (DB routing authority). pollStatus() consumes ONLY packets whose content_sha256
 * matches an unconsumed row; unmatched/forged files are ignored, flagged (event), and quarantined.
 */
export abstract class BaseAdapter implements AgentAdapter {
  readonly id: string
  readonly capabilities: string[]
  readonly wakeMode: 'auto' | 'user_initiated'
  readonly mailRoot: string

  constructor(opts: BaseAdapterOptions) {
    this.id = opts.id
    this.capabilities = opts.capabilities
    this.wakeMode = opts.wakeMode
    this.mailRoot = opts.mailRoot ?? ''
  }

  async dispatch(packet: Packet): Promise<DispatchResult> {
    if (packet.recipient !== this.id) {
      throw new Error(`adapter ${this.id} cannot dispatch to ${packet.recipient}`)
    }
    // D1: commit the authoritative row + its publish-outbox entry atomically (routePacket), then
    // drain to materialize the file. If the process dies before the drain, the reconciler publishes
    // it from the persisted payload on restart — exactly once. Nothing is observable in unread/
    // before its row exists (FDQ-B8 preserved).
    const routed = await routePacket({ ...packet, mailRoot: this.mailRoot })
    await drainOutbox()
    const path = routed.deduped ? (routed.message.body_path ?? routed.finalPath) : routed.finalPath
    return { message: routed.message, path, deduped: routed.deduped }
  }

  async pollStatus(): Promise<PollResult> {
    const result: PollResult = { consumed: [], flagged: [] }
    for (const path of listBox(this.id, 'unread', this.mailRoot)) {
      const content = readPacket(path)
      const contentSha = sha256(content)
      const row = await findUnconsumedByHash(this.id, contentSha)

      if (!row) {
        // Unmatched/forged: the DB has no unconsumed row for this content. Do not dispatch.
        await recordEvent({
          kind: 'packet.unmatched',
          source: this.id,
          payload: { path, content_sha256: contentSha, recipient: this.id },
          dedupKey: `unmatched:${this.id}:${contentSha}`,
        })
        const moved = movePacket(this.id, path, 'flagged', this.mailRoot)
        result.flagged.push({ path: moved, content_sha256: contentSha, reason: 'no-matching-unconsumed-row' })
        continue
      }

      await consume(row.id, this.id)
      const moved = movePacket(this.id, path, 'read', this.mailRoot)
      result.consumed.push({ message: row, content, path: moved })
    }
    return result
  }
}
