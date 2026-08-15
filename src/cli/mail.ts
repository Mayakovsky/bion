import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { closePool } from '../db/pool.js'
import { pointer, serialize, parse, validate } from '../comms/protocol.js'
import { KovAdapter } from '../adapters/kov.js'
import { DesktopAdapter } from '../adapters/desktop.js'
import type { AgentAdapter, DispatchResult, PollResult } from '../adapters/types.js'

// `bion mail send` / `bion mail poll` (directive-71) — CLI over the mailbox that already exists
// (src/mailbox/mailbox.ts, src/adapters/*.ts). Same argv-parsing approach as `bion task`
// (src/cli/task.ts): `--flag value` pairs, bare `--flag` reads as 'true', everything else positional.
// `--field k=v` is repeatable and collects into a fields map (task.ts's flags are single-value only).

export interface ParsedMailArgv {
  positional: string[]
  flags: Record<string, string>
  fields: Record<string, string>
}

export function parseMailArgv(argv: string[]): ParsedMailArgv {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  const fields: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--field') {
      const kv = argv[++i]
      if (kv === undefined) throw new Error('--field requires a k=v argument')
      const eq = kv.indexOf('=')
      if (eq <= 0) throw new Error(`--field must be k=v, got "${kv}"`)
      fields[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim()
    } else if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags, fields }
}

export interface SendArgs {
  from: string
  to: string
  intent: string
  refs: string[]
  fields: Record<string, string>
  note?: string
  thread?: string
  type?: string
  summary?: string
}

const SEND_USAGE =
  'usage: bion mail send --from <kov|desktop> --to <kov|desktop> --intent <opcode> ' +
  '[--refs a,b,c] [--field k=v ...] [--note "<text>"] [--thread <id>] [--type <type>] [--summary <text>]'

export function parseSendArgs(argv: string[]): SendArgs {
  const { flags, fields } = parseMailArgv(argv)
  if (!flags.from) throw new Error(SEND_USAGE)
  if (!flags.to) throw new Error('--to is required')
  if (!flags.intent) throw new Error('--intent is required')
  return {
    from: flags.from,
    to: flags.to,
    intent: flags.intent,
    refs: flags.refs ? flags.refs.split(',').map((s) => s.trim()).filter(Boolean) : [],
    fields,
    note: flags.note,
    thread: flags.thread,
    type: flags.type,
    summary: flags.summary,
  }
}

export interface PollArgs {
  as: string
}

export function parsePollArgs(argv: string[]): PollArgs {
  const { flags } = parseMailArgv(argv)
  if (!flags.as) throw new Error('usage: bion mail poll --as <kov|desktop>')
  return { as: flags.as }
}

function adapterFor(id: string, mailRoot?: string): AgentAdapter {
  if (id === 'kov') return new KovAdapter({ mailRoot })
  if (id === 'desktop') return new DesktopAdapter({ mailRoot })
  throw new Error(`unknown agent id "${id}" — expected kov or desktop`)
}

/**
 * Build the envelope via pointer()/serialize(), validate() it (hard stop on failure — no dispatch,
 * so no file written and no DB row created), then dispatch on the RECIPIENT's adapter (dispatch()
 * throws if packet.recipient !== that adapter's id, so --to must resolve the right instance).
 */
export async function sendMail(args: SendArgs, opts: { mailRoot?: string } = {}): Promise<DispatchResult> {
  const msg = pointer(args.intent, { refs: args.refs, fields: args.fields, note: args.note })
  const v = validate(msg)
  if (!v.ok) throw new Error(`mail send: validation failed — ${v.errors.join('; ')}`)

  const body = serialize(msg)
  const recipient = adapterFor(args.to, opts.mailRoot)
  return recipient.dispatch({
    sender: args.from,
    recipient: args.to,
    body,
    origin: args.from,
    thread: args.thread,
    type: args.type,
    summary: args.summary,
  })
}

export async function pollMail(args: PollArgs, opts: { mailRoot?: string } = {}): Promise<PollResult> {
  const self = adapterFor(args.as, opts.mailRoot)
  return self.pollStatus()
}

export function formatPollResult(result: PollResult): string {
  const lines: string[] = []
  for (const c of result.consumed) {
    const msg = parse(c.content)
    lines.push(`[consumed] ${c.path}`)
    lines.push(`  intent=${msg.intent}`)
    if (msg.refs.length) lines.push(`  refs=${msg.refs.join(',')}`)
    for (const [k, val] of Object.entries(msg.fields)) lines.push(`  field ${k}=${val}`)
    if (msg.note) lines.push(`  note: ${msg.note}`)
  }
  for (const f of result.flagged) {
    lines.push(`[flagged] ${f.path} — ${f.reason} (content_sha256=${f.content_sha256})`)
  }
  return lines.length ? lines.join('\n') : '(no mail)'
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'send') {
    const result = await sendMail(parseSendArgs(rest))
    console.log(`message id: ${result.message.id}`)
    console.log(`path: ${result.path}`)
    if (result.deduped) console.log('(deduped: identical packet already existed)')
  } else if (cmd === 'poll') {
    const result = await pollMail(parsePollArgs(rest))
    console.log(formatPollResult(result))
  } else {
    throw new Error('usage: bion mail <send|poll> ...')
  }
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('bion mail failed:', err.message)
      process.exit(1)
    })
}
