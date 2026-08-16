import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createDesktopMailServer, mailboxRoot } from '../src/index.js'

// Exercises the real MCP protocol boundary (tool registration, zod argument validation, error
// surfacing) via an in-memory client<->server pair — sendMail()/pollMail() themselves are already
// covered by test/mail_cli.test.ts, so these tests focus on what the MCP wrapper adds.

function freshRoot(): string {
  return join(tmpdir(), `bion-mail-mcp-${randomUUID()}`)
}

async function connectedClient() {
  const server = createDesktopMailServer()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, server }
}

describe('desktop mail MCP server (directive-73 Task 2)', () => {
  let root: string
  const origMailRoot = process.env.BION_MAIL_ROOT

  beforeEach(() => {
    root = freshRoot()
    // sendMail()/pollMail() don't take a root override in their MCP-facing call shape here, so
    // point the whole process at a temp root via the same env var mailboxRoot() itself falls back
    // to (src/mailbox/mailbox.ts) — isolates these tests from the real .bion/mail/.
    process.env.BION_MAIL_ROOT = root
  })

  afterEach(() => {
    if (origMailRoot === undefined) delete process.env.BION_MAIL_ROOT
    else process.env.BION_MAIL_ROOT = origMailRoot
  })

  it('lists exactly the two tools, nothing more', async () => {
    const { client } = await connectedClient()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['poll_mail', 'send_mail'])
  })

  it('send_mail -> poll_mail round-trips a real packet through the MCP boundary', async () => {
    const { client } = await connectedClient()
    const note = 'mcp boundary round trip'
    // recipient 'desktop' (self-addressed): poll_mail only reads Desktop's own inbox, so a
    // same-process round trip has to land the packet there, not in kov's.
    const sendResult = await client.callTool({
      name: 'send_mail',
      arguments: {
        recipient: 'desktop',
        intent: 'status',
        fields: { topic: 'mcp-test' },
        note,
        thread: `t-mcp-${randomUUID()}`,
      },
    })
    expect(sendResult.isError).toBeFalsy()
    const sendText = (sendResult.content as Array<{ type: string; text: string }>)[0]!.text
    expect(sendText).toMatch(/^sent: message id [0-9a-f-]+, path /)

    const pollResult = await client.callTool({ name: 'poll_mail', arguments: {} })
    expect(pollResult.isError).toBeFalsy()
    const pollText = (pollResult.content as Array<{ type: string; text: string }>)[0]!.text
    expect(pollText).toContain('intent=status')
    expect(pollText).toContain('field topic=mcp-test')
    expect(pollText).toContain(note)
  })

  it('rejects an invalid recipient before send() ever runs (zod argument validation)', async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({
      name: 'send_mail',
      arguments: { recipient: 'not-a-real-agent', intent: 'status', fields: { a: 'b' } },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toMatch(/invalid arguments/i)
    expect(text).toContain('recipient')
  })

  it('surfaces a validate() failure (under-specified pointer) as a tool error, not a crash', async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({
      name: 'send_mail',
      arguments: { recipient: 'kov', intent: 'dispatch' }, // no refs, no fields -> validate() fails
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toContain('send_mail failed')
    expect(text).toMatch(/validation failed/)
  })

  it('poll_mail against an empty mailbox reports cleanly, no error', async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({ name: 'poll_mail', arguments: {} })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toBe('(no mail)')
  })

  it('mailboxRoot() honors BION_MAIL_ROOT the way these tests rely on', () => {
    expect(mailboxRoot()).toBe(root)
  })
})
