import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { repoPath } from '../paths.js'
import { query } from '../db/pool.js'
import type { QueryHit } from './types.js'

export interface QueryStateOptions {
  limit?: number
  /** Also grep the disk mailbox for the raw terms (spec §3.3). Default true. */
  grepDisk?: boolean
  mailboxRoot?: string
}

export interface DiskHit {
  path: string
  line: number
  text: string
}

export interface QueryStateResult {
  hits: QueryHit[]
  diskHits: DiskHit[]
}

/**
 * query_state(query) — Postgres FTS over messages/decisions/fdqs/invariants + disk grep
 * of the mailbox. Bion never grows a retrieval engine beyond relational + FTS (inv 7).
 */
export async function queryState(q: string, opts: QueryStateOptions = {}): Promise<QueryStateResult> {
  const limit = opts.limit ?? 25
  const res = await query<QueryHit>(
    `
    WITH qy AS (SELECT websearch_to_tsquery('english', $1) AS q)
    SELECT 'message'::text AS kind, id, summary AS snippet, ts_rank(search_tsv, qy.q) AS rank
      FROM messages, qy WHERE search_tsv @@ qy.q
    UNION ALL
    SELECT 'decision', id, decision, ts_rank(search_tsv, qy.q) FROM decisions, qy WHERE search_tsv @@ qy.q
    UNION ALL
    SELECT 'fdq', id, question, ts_rank(search_tsv, qy.q) FROM fdqs, qy WHERE search_tsv @@ qy.q
    UNION ALL
    SELECT 'invariant', id, statement, ts_rank(search_tsv, qy.q) FROM invariants, qy WHERE search_tsv @@ qy.q
    ORDER BY rank DESC, id
    LIMIT $2
    `,
    [q, limit],
  )

  const diskHits =
    opts.grepDisk === false ? [] : grepMailbox(q, opts.mailboxRoot ?? repoPath('.bion', 'mail'))

  return { hits: res.rows, diskHits }
}

/** Case-insensitive substring grep over markdown packets under the mailbox root. */
function grepMailbox(term: string, root: string): DiskHit[] {
  if (!existsSync(root)) return []
  const needle = term.toLowerCase()
  const out: DiskHit[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (entry.endsWith('.md')) {
        const lines = readFileSync(p, 'utf8').split(/\r?\n/)
        lines.forEach((text, i) => {
          if (text.toLowerCase().includes(needle)) out.push({ path: p, line: i + 1, text })
        })
      }
    }
  }
  walk(root)
  return out
}
