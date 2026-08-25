import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { sendMail, pollMail, formatPollResult } from '../cli/mail.js'
import { isValidProjectName, RESERVED_BOX_NAMES } from '../mailbox/mailbox.js'
import { closePool } from '../db/pool.js'

// Desktop mail MCP server (directive-73 Task 2). Desktop's own general-purpose `bion-postgres`
// connector is read-only at the client/tool level (confirmed empirically — it refuses non-SELECT
// SQL regardless of the DB role's actual grants), so Desktop can't consume or send mail through it.
// The fix is not "make that connector read-write" (a much bigger surface than the actual need) —
// it's this: a small, purpose-built stdio server exposing exactly the two operations Desktop
// needs, as thin wrappers over D-71's already-built, already-tested sendMail()/pollMail()
// (src/cli/mail.ts). No mailbox logic lives here.
//
// Runs on the real machine (unlike Desktop's sandbox), so it reuses BION_DATABASE_URL/bion_rw —
// the same connection Kov's CLI already uses. bion_rw has had SELECT+INSERT on
// message_consumptions since day one (migrations/0002_grants.sql); no new DB role.

const SEND_MAIL_INPUT = {
  recipient: z.enum(['kov', 'desktop']).describe('Who receives this packet — almost always "kov".'),
  intent: z.string().min(1).describe('One verb/opcode, e.g. "status", "review", "escalate".'),
  refs: z.array(z.string()).optional().describe('Addresses of the truth: file paths, commit SHAs, task ids, diff ranges.'),
  fields: z.record(z.string(), z.string()).optional().describe('The minimal structured data needed to act.'),
  note: z.string().optional().describe('Optional terse note, hard-capped at ~20 words.'),
  thread: z.string().optional(),
  type: z.string().optional(),
  summary: z.string().optional(),
  project: z
    .string()
    .optional()
    .describe(
      'Mailbox scoping (directive-146/150/154) — same shape as `bion mail send --project`. Omitted → unscoped (the historical flat shape).',
    ),
}

export function createDesktopMailServer(): McpServer {
  const server = new McpServer({ name: 'bion-desktop-mail', version: '1.0.0' })

  server.registerTool(
    'send_mail',
    {
      title: 'Send mail',
      description:
        'Send a Comms Protocol v1 packet through Bion\'s mailbox. Sender is always "desktop" — this server only ever acts as Desktop.',
      inputSchema: SEND_MAIL_INPUT,
    },
    async (args) => {
      try {
        if (args.project !== undefined && !isValidProjectName(args.project)) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `send_mail failed: project cannot be one of the reserved box names (${[...RESERVED_BOX_NAMES].join(', ')}) — got "${args.project}"`,
              },
            ],
          }
        }
        const result = await sendMail({
          from: 'desktop',
          to: args.recipient,
          intent: args.intent,
          refs: args.refs ?? [],
          fields: args.fields ?? {},
          note: args.note,
          thread: args.thread,
          type: args.type,
          summary: args.summary,
          project: args.project,
        })
        const dedupNote = result.deduped ? ' (deduped: identical packet already existed)' : ''
        return {
          content: [{ type: 'text', text: `sent: message id ${result.message.id}, path ${result.path}${dedupNote}` }],
        }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `send_mail failed: ${(err as Error).message}` }] }
      }
    },
  )

  server.registerTool(
    'poll_mail',
    {
      title: 'Poll mail',
      description:
        "Consume Desktop's unread mailbox. Only DB-corroborated packets are consumed and moved to read/; unmatched/forged files are flagged, not trusted.",
    },
    async () => {
      try {
        const result = await pollMail({ as: 'desktop' })
        return { content: [{ type: 'text', text: formatPollResult(result) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `poll_mail failed: ${(err as Error).message}` }] }
      }
    },
  )

  return server
}

async function main(): Promise<void> {
  const server = createDesktopMailServer()
  await server.connect(new StdioServerTransport())
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const shutdown = (): void => {
    closePool().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  main().catch((err) => {
    console.error('bion-desktop-mail failed to start:', err.message)
    process.exit(1)
  })
}
