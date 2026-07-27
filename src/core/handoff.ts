import { query } from '../db/pool.js'

export interface HandoffOptions {
  recentDecisions?: number
  recentMessages?: number
}

export interface HandoffPacket {
  target: string
  markdown: string
}

/**
 * handoff(target_agent) — summarize recent Bion state into a handoff packet formatted for
 * the next agent (spec §3.3). Phase A returns the markdown; Phase B routes it via the mailbox.
 */
export async function handoff(target: string, opts: HandoffOptions = {}): Promise<HandoffPacket> {
  const nDec = opts.recentDecisions ?? 5
  const nMsg = opts.recentMessages ?? 5

  const [openFdqs, inProgress, recentDecisions, recentMessages] = await Promise.all([
    query<{ id: string; question: string }>(
      `SELECT id, question FROM fdqs WHERE status = 'open' ORDER BY opened DESC`,
    ),
    query<{ id: string; title: string; status: string }>(
      `SELECT id, title, status FROM tasks WHERE status IN ('ready','in_progress','blocked') ORDER BY priority DESC, updated DESC`,
    ),
    query<{ id: string; decision: string }>(
      `SELECT id, decision FROM decisions ORDER BY ts DESC LIMIT $1`,
      [nDec],
    ),
    query<{ id: string; sender: string; recipient: string; summary: string }>(
      `SELECT id, sender, recipient, summary FROM messages ORDER BY ts DESC LIMIT $1`,
      [nMsg],
    ),
  ])

  const lines: string[] = []
  lines.push(`# Handoff → ${target}`, '')
  lines.push('## Open FDQs')
  lines.push(...(openFdqs.rows.length ? openFdqs.rows.map((f) => `- ${f.id}: ${f.question}`) : ['- (none)']))
  lines.push('', '## Active tasks')
  lines.push(
    ...(inProgress.rows.length
      ? inProgress.rows.map((t) => `- ${t.id} [${t.status}]: ${t.title}`)
      : ['- (none)']),
  )
  lines.push('', '## Recent decisions')
  lines.push(
    ...(recentDecisions.rows.length
      ? recentDecisions.rows.map((d) => `- ${d.id}: ${d.decision}`)
      : ['- (none)']),
  )
  lines.push('', '## Recent messages')
  lines.push(
    ...(recentMessages.rows.length
      ? recentMessages.rows.map((m) => `- ${m.id} ${m.sender}→${m.recipient}: ${m.summary}`)
      : ['- (none)']),
  )
  lines.push('')

  return { target, markdown: lines.join('\n') }
}
