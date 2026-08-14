import { config } from 'dotenv'
import { dirname } from 'node:path'
import { repoPath, repoRoot } from './paths.js'

/** Absolute path to .env.local, resolved relative to the repo root (NOT process.cwd()). */
export function resolveEnvPath(): string {
  return repoPath('.env.local')
}

// Load .env.local module-relative so it loads identically from any cwd (directive-11).
// Real env vars, if already set, take precedence (dotenv does not override by default).
config({ path: resolveEnvPath() })

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
  /** Absolute path to the /dev root Bion auto-discovers watched repos under (directive-68,
   *  replaces GREY_REPO_PATH). Default is derived, not hardcoded: repoRoot() is `.../dev/bion/repo`,
   *  so two levels up is `.../dev` — safe-by-default, overridable via BION_DEV_ROOT for tests or a
   *  differently-laid-out machine. */
  get devRoot(): string {
    return process.env.BION_DEV_ROOT || dirname(dirname(repoRoot()))
  },
}
