import { sha256 } from '../core/ids.js'
import { send } from '../core/send.js'
import { recordEvent } from '../core/events.js'
import { consume, findUnconsumedByHash } from '../core/consumption.js'
import { discardStaged, listBox, movePacket, publishStaged, readPacket, stagePacket } from '../mailbox/mailbox.js'
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
  protected readonly mailRoot: string

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
    // FDQ-B8: stage the payload (invisible in unread/), commit the authoritative row with its final
    // body_path, THEN atomically publish. A poll landing in the window sees nothing to quarantine,
    // because the packet is only visible in unread/ once its row already exists.
    const staged = stagePacket(packet.recipient, packet.body, { root: this.mailRoot })
    try {
      const { message, deduped } = await send({
        sender: packet.sender,
        recipient: packet.recipient,
        thread: packet.thread,
        type: packet.type,
        summary: packet.summary,
        body: packet.body,
        bodyPath: staged.finalPath,
        origin: packet.origin,
      })
      if (deduped) {
        // Identical packet already registered + published on a prior dispatch — re-publishing would
        // create an orphan file. Drop the stage; return the existing row's path.
        discardStaged(staged)
        return { message, path: message.body_path ?? staged.finalPath, deduped }
      }
      const path = publishStaged(staged)
      return { message, path, deduped }
    } catch (err) {
      discardStaged(staged)
      throw err
    }
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
