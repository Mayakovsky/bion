import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { existsSync } from 'node:fs'
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

  // directive-154: the real gap D-153 found — send_mail's schema had no `project` field, so every
  // Desktop-originated send landed unscoped by omission regardless of intent. These prove the fix
  // through the actual MCP protocol boundary (in-memory client<->server, real tool call), not by
  // calling sendMail() directly — that path was already proven in D-150.
  it('send_mail with project set lands in the real per-project subfolder, through the MCP path', async () => {
    const { client } = await connectedClient()
    // thread carries a fresh token each run — without it, identical literal content across two
    // runs (e.g. this file run standalone, then again inside the full suite against the same real
    // DB) hits the same dedup_key and silently returns the FIRST run's (now-stale) path instead of
    // materializing a new one — a real bug this test itself hit and is now guarded against.
    const sendResult = await client.callTool({
      name: 'send_mail',
      arguments: {
        recipient: 'kov',
        intent: 'status',
        fields: { topic: 'mcp-project-test' },
        note: 'directive-154 mcp project round trip',
        project: 'scratch-d154-mcp',
        thread: `t-d154-project-${randomUUID()}`,
      },
    })
    expect(sendResult.isError).toBeFalsy()
    const sendText = (sendResult.content as Array<{ type: string; text: string }>)[0]!.text
    const pathMatch = sendText.match(/path (.+)$/)
    expect(pathMatch, 'send_mail should report the real on-disk path').toBeTruthy()
    const path = pathMatch![1]!.replace(/\\/g, '/')
    expect(path).toContain('/kov/scratch-d154-mcp/unread/')
    expect(existsSync(pathMatch![1]!)).toBe(true)
  })

  it('send_mail rejects a project matching a reserved box name, through the MCP path, before send() runs', async () => {
    const { client } = await connectedClient()
    const result = await client.callTool({
      name: 'send_mail',
      arguments: { recipient: 'kov', intent: 'status', fields: { a: 'b' }, project: 'unread' },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toContain('reserved box names')
  })
})
