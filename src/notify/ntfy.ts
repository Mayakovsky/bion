import { env } from '../env.js'

// ntfy notifier — pushes human-decision-required events to Forces. Credentials travel via the
// Authorization header ONLY and are never logged (inv 9 / FDQ-43). When BION_NTFY_URL is unset
// (placeholder), the notifier runs in dry-run mode so the loop is testable without live creds;
// Forces supplies the live URL + token at deploy time.

export interface NotifyInput {
  title: string
  message: string
  /** ntfy priority 1..5 (5 = max). */
  priority?: number
  tags?: string[]
}

export interface NotifyResult {
  sent: boolean
  dryRun: boolean
  status?: number
}

export type NotifyFn = (input: NotifyInput) => Promise<NotifyResult>

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>

export interface NotifyOptions {
  url?: string
  token?: string
  fetchImpl?: FetchLike
}

/** A log-safe one-line description of a notification. Deliberately omits URL + token (inv 9). */
export function describeNotify(input: NotifyInput): string {
  return `[ntfy] "${input.title}" prio=${input.priority ?? 3} tags=${(input.tags ?? []).join(',')}`
}

export async function notifyForces(input: NotifyInput, opts: NotifyOptions = {}): Promise<NotifyResult> {
  const url = opts.url ?? env.ntfyUrl
  const token = opts.token ?? env.ntfyToken
  if (!url) return { sent: false, dryRun: true }

  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const headers: Record<string, string> = {
    Title: input.title,
    Priority: String(input.priority ?? 3),
    Tags: (input.tags ?? []).join(','),
  }
  if (token) headers.Authorization = `Bearer ${token}` // auth header only; never logged

  const res = await doFetch(url, { method: 'POST', headers, body: input.message })
  return { sent: res.ok, dryRun: false, status: res.status }
}
