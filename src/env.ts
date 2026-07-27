import { config } from 'dotenv'
import { resolve } from 'node:path'

// Load .env.local from the repo root (real env vars, if set, take precedence).
config({ path: resolve(process.cwd(), '.env.local') })

function required(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var ${name} (see .env.example / .env.local)`)
  }
  return v
}

export interface ParsedDbUrl {
  host: string
  port: string
  database: string
  user: string
}

/** Parse a postgres URL into its addressable parts (no password exposed). */
export function parseDbUrl(url: string): ParsedDbUrl {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: u.port || '5432',
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: decodeURIComponent(u.username),
  }
}

export const env = {
  /** Runtime (least-privilege) connection — bion_rw. */
  get databaseUrl(): string {
    return required('BION_DATABASE_URL')
  },
  /** Migration/owner connection — bion_owner. Optional at runtime; required for `pnpm migrate`. */
  get migrateUrl(): string {
    return required('BION_MIGRATE_URL')
  },
  ntfyUrl: process.env.BION_NTFY_URL ?? '',
  ntfyToken: process.env.BION_NTFY_TOKEN ?? '',
}
