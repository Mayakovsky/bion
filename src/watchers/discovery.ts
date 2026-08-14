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

/** Every immediate subdirectory of `dir` that itself has a `.git`, sorted alphabetically by
 *  directory name — deterministic, not dependent on `readdirSync`'s own (unordered) return order. */
function findNestedGitDirs(dir: string): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // unreadable — not a repo we can watch
  }
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, '.git')))
    .map((entry) => entry.name)
    .sort()
}

export interface DiscoveryOptions {
  /** Override for `.bion/bionignore`'s location (tests isolate this). */
  ignorePath?: string
}

/**
 * List every repo under `devRoot`. For each top-level directory:
 *  - a `.git` at its own root → one `RepoRef` named after the top-level directory.
 *  - no `.git` at its root, exactly one nested `.git` one level below → one `RepoRef`, still named
 *    after the top-level directory (bion's `repo/` nesting shape — unchanged from before this
 *    addendum, since real `git.commit` events already exist under dedup keys built from that name).
 *  - no `.git` at its root, MORE THAN ONE nested `.git` one level below (directive-68 addendum —
 *    `eliza`'s shape) → one `RepoRef` per nested repo, named `<top>/<nested>`, sorted alphabetically
 *    so the set is deterministic across runs/environments instead of picking whichever one
 *    `readdirSync` happened to return first.
 * `.bion/bionignore` excludes by matching either a top-level directory's own name (drops the whole
 * directory, including every nested repo under it) or, for the multi-nested case, a nested
 * directory's own bare name (drops just that one sibling) — NOT a compound `top/nested` pattern,
 * a deliberate choice to keep the matcher single-purpose; a bare nested name matches under any
 * top-level parent it appears under.
 * Re-run each tick (daemon.ts) so a repo added mid-run is picked up without a restart — this
 * function does no caching of its own.
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
    const topDir = join(devRoot, entry.name)
    if (existsSync(join(topDir, '.git'))) {
      repos.push({ name: entry.name, path: topDir })
      continue
    }
    const nested = findNestedGitDirs(topDir)
    if (nested.length === 0) continue
    if (nested.length === 1) {
      repos.push({ name: entry.name, path: join(topDir, nested[0]!) })
      continue
    }
    for (const nestedName of nested) {
      if (isIgnored(nestedName, patterns)) continue
      repos.push({ name: `${entry.name}/${nestedName}`, path: join(topDir, nestedName) })
    }
  }
  return repos
}
