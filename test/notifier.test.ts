import { describe, it, expect } from 'vitest'
import { notifyForces, describeNotify } from '../src/index.js'

describe('ntfy notifier (auth header only, never in logs — inv 9)', () => {
  it('dry-runs when no URL is configured (placeholder-safe)', async () => {
    const r = await notifyForces({ title: 't', message: 'm' }, { url: '' })
    expect(r).toEqual({ sent: false, dryRun: true })
  })

  it('tokenless: sends NO Authorization header when the token is empty', async () => {
    const captured: { url: string; init: RequestInit }[] = []
    const fetchImpl = async (url: string, init: RequestInit) => {
      captured.push({ url, init })
      return { ok: true, status: 200 }
    }
    const r = await notifyForces(
      { title: 'anon', message: 'tokenless', priority: 3, tags: ['bion'] },
      { url: 'https://ntfy.sh/bion-topic', token: '', fetchImpl },
    )
    expect(r).toEqual({ sent: true, dryRun: false, status: 200 })
    const headers = captured[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined() // secured by topic-name obscurity only (FDQ-B14)
    expect(headers.Title).toBe('anon')
  })

  it('sends the token via the Authorization header, not the URL or body', async () => {
    const captured: { url: string; init: RequestInit }[] = []
    const fetchImpl = async (url: string, init: RequestInit) => {
      captured.push({ url, init })
      return { ok: true, status: 200 }
    }
    const token = 'super-secret-token'
    const r = await notifyForces(
      { title: 'review', message: 'task done', priority: 4, tags: ['bion', 'review'] },
      { url: 'https://ntfy.example/bion-topic', token, fetchImpl },
    )

    expect(r).toEqual({ sent: true, dryRun: false, status: 200 })
    const req = captured[0]!
    const headers = req.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${token}`)
    // the secret must not leak into the URL or the message body
    expect(req.url).not.toContain(token)
    expect(String(req.init.body)).not.toContain(token)
  })

  it('the log-safe description omits any credential', () => {
    const line = describeNotify({ title: 'review', message: 'x', priority: 4, tags: ['bion'] })
    expect(line).toContain('review')
    expect(line).not.toContain('Bearer')
    expect(line).not.toContain('token')
  })
})
