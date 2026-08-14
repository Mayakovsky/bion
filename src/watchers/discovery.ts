import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoRef } from './gitWatcher.js'
import { repoPath } from '../paths.js'

// Dev-root-wide repo discovery (directive-68) — replaces the GREY_REPO_PATH/static-list pattern.
// Auto-discovery is the default (Forces, 2026-08-14): any directory under the dev root with a
// `.git` at itself or one level below (handles bion's own `repo/` nesting without special-casing
// bion by name) is a watched repo, no per-repo opt-in. `.bion/bionignore` is the only deviation
// mechanism — absent/empty by default, matching "auto-discovery by default" exactly.

export const BIONIGNORE_FILENAME = 'bionignore'

/** Default location: inside the existing gitignored `.bion/` runtime-state dir (never committed). */
export function defaultIgnorePath(): string {
  return repoPath('.bion', BIONIGNORE_FILENAME)
}

function loadIgnorePatterns(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

// Gitignore-style, deliberately minimal: `*` and `?` wildcards, matched against the discovered
// directory's name (relative to the dev root) — no path segments, no dependency needed for
// something this narrow (§3).
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function isIgnored(name: string, patterns: string[]): boolean {
  return patterns.some((p) => patternToRegex(p).test(name))
}

/** Find a `.git` at `dir` itself, or exactly one level below it (bion's `repo/` nesting shape).
 *  Returns the directory that actually holds `.git`, or null if neither has one. */
function findGitRoot(dir: string): string | null {
  if (existsSync(join(dir, '.git'))) return dir
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null // unreadable — not a repo we can watch
  }
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(join(dir, entry.name, '.git'))) return join(dir, entry.name)
  }
  return null
}

export interface DiscoveryOptions {
  /** Override for `.bion/bionignore`'s location (tests isolate this). */
  ignorePath?: string
}

/**
 * List every repo under `devRoot`: each top-level directory with a `.git` at itself or one level
 * below, minus anything `.bion/bionignore` excludes. Re-run each tick (daemon.ts) so a repo added
 * mid-run is picked up without a restart — this function does no caching of its own.
 */
export function discoverRepos(devRoot: string, opts: DiscoveryOptions = {}): RepoRef[] {
  const patterns = loadIgnorePatterns(opts.ignorePath ?? defaultIgnorePath())
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(devRoot, { withFileTypes: true })
  } catch {
    return [] // bad/missing dev root — no repos, isolated the same way a bad repo path is elsewhere
  }
  const repos: RepoRef[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || isIgnored(entry.name, patterns)) continue
    const gitRoot = findGitRoot(join(devRoot, entry.name))
    if (gitRoot) repos.push({ name: entry.name, path: gitRoot })
  }
  return repos
}
