// Row shapes mirroring the data model (spec §4). Timestamps come back as Date from pg.

export interface Message {
  id: string
  ts: Date
  sender: string
  recipient: string
  thread: string | null
  type: string
  summary: string
  body_path: string | null
  content_sha256: string
  dedup_key: string
  origin: string
}

export interface Task {
  id: string
  title: string
  description: string
  owner: string | null
  priority: number
  status: 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'failed'
  dependencies: string[]
  ratified: boolean
  created: Date
  updated: Date
}

export interface Decision {
  id: string
  ts: Date
  decision: string
  rationale: string
  impact: string
  movement: string | null
  supersedes: string | null
}

export interface Fdq {
  id: string
  movement: string | null
  question: string
  ruling: string | null
  status: 'open' | 'resolved'
  opened: Date
  resolved: Date | null
}

export interface Invariant {
  id: string
  statement: string
  movement: string | null
  active: boolean
}

export interface Agent {
  id: string
  type: string
  capabilities: string[]
  wake_mode: 'auto' | 'user_initiated'
  authority: Record<string, unknown>
}

export interface BionEvent {
  id: string
  ts: Date
  kind: string
  payload: Record<string, unknown>
  source: string
  dedup_key: string
}

export interface QueryHit {
  kind: 'message' | 'decision' | 'fdq' | 'invariant'
  id: string
  snippet: string
  rank: number
}
