import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import {
  parseMailArgv,
  parseSendArgs,
  parsePollArgs,
  sendMail,
  pollMail,
  formatPollResult,
  mailboxRoot,
  query,
} from '../src/index.js'

function freshRoot(): string {
  return join(tmpdir(), `bion-mail-cli-${randomUUID()}`)
}

describe('bion mail argv parsing', () => {
  it('parseMailArgv collects repeatable --field k=v pairs into a fields map', () => {
    const { flags, fields, positional } = parseMailArgv([
      '--from', 'kov', '--to', 'desktop', '--intent', 'status',
      '--field', 'topic=comms-pilot', '--field', 'phase=infra',
      '--note', 'a short note',
    ])
    expect(positional).toEqual([])
    expect(flags.from).toBe('kov')
    expect(flags.to).toBe('desktop')
    expect(flags.intent).toBe('status')
    expect(flags.note).toBe('a short note')
    expect(fields).toEqual({ topic: 'comms-pilot', phase: 'infra' })
  })

  it('parseSendArgs requires --from/--to/--intent and splits --refs on commas', () => {
    expect(() => parseSendArgs([])).toThrow(/usage/)
    expect(() => parseSendArgs(['--from', 'kov'])).toThrow(/--to is required/)
    expect(() => parseSendArgs(['--from', 'kov', '--to', 'desktop'])).toThrow(/--intent is required/)

    const args = parseSendArgs(['--from', 'kov', '--to', 'desktop', '--intent', 'review', '--refs', 'a,b, c'])
    expect(args.refs).toEqual(['a', 'b', 'c'])
    expect(args.from).toBe('kov')
    expect(args.to).toBe('desktop')
  })

  it('parsePollArgs requires --as', () => {
    expect(() => parsePollArgs([])).toThrow(/usage/)
    expect(parsePollArgs(['--as', 'desktop'])).toEqual({ as: 'desktop' })
  })
})

describe('bion mail send -> poll round trip (real temp mailbox root)', () => {
  it('a sent packet is exactly what poll reports, and the file lands under <root>/desktop/unread', async () => {
    const root = freshRoot()
    const note = 'round trip proof for the mail cli'
    const sent = await sendMail(
      {
        from: 'kov',
        to: 'desktop',
        intent: 'status',
        refs: ['task:T-cli'],
        fields: { topic: 'comms-pilot' },
        note,
        thread: `t-mailcli-${randomUUID()}`, // unique dedup_key across repeated test runs
      },
      { mailRoot: root },
    )
    expect(sent.deduped).toBe(false)
    expect(sent.path.replace(/\\/g, '/')).toContain('/desktop/unread/')
    expect(existsSync(sent.path)).toBe(true)

    const poll = await pollMail({ as: 'desktop' }, { mailRoot: root })
    expect(poll.consumed).toHaveLength(1)
    expect(poll.flagged).toHaveLength(0)
    const parsed = poll.consumed[0]!
    expect(parsed.message.id).toBe(sent.message.id)
    expect(parsed.content).toContain('@intent status')
    expect(parsed.content).toContain('@field topic=comms-pilot')
    expect(parsed.content).toContain(`@note ${note}`)

    const rendered = formatPollResult(poll)
    expect(rendered).toContain('intent=status')
    expect(rendered).toContain('field topic=comms-pilot')
    expect(rendered).toContain(note)

    // it moved unread -> read, not left behind
    expect(existsSync(sent.path)).toBe(false)
  })

  it('a validate() failure is a hard stop: no file written, no messages row created', async () => {
    const root = freshRoot()
    const before = await query<{ n: string }>(`SELECT count(*)::text AS n FROM messages`)

    await expect(
      sendMail({ from: 'kov', to: 'desktop', intent: 'dispatch', refs: [], fields: {} }, { mailRoot: root }),
    ).rejects.toThrow(/validation failed/)

    const after = await query<{ n: string }>(`SELECT count(*)::text AS n FROM messages`)
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n)

    // nothing at all was staged/published for this fresh root
    const desktopUnread = join(mailboxRoot(root), 'desktop', 'unread')
    expect(existsSync(desktopUnread) ? readdirSync(desktopUnread) : []).toEqual([])
  })

  it('a note over the 20-word cap is also rejected before dispatch', async () => {
    const root = freshRoot()
    const longNote = Array.from({ length: 25 }, () => 'w').join(' ')
    await expect(
      sendMail(
        { from: 'kov', to: 'desktop', intent: 'status', refs: [], fields: { a: 'b' }, note: longNote },
        { mailRoot: root },
      ),
    ).rejects.toThrow(/validation failed/)
  })

  it('poll against an empty mailbox reports nothing, cleanly', async () => {
    const root = freshRoot()
    const poll = await pollMail({ as: 'kov' }, { mailRoot: root })
    expect(poll.consumed).toEqual([])
    expect(poll.flagged).toEqual([])
    expect(formatPollResult(poll)).toBe('(no mail)')
  })
})
