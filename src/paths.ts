import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve Bion paths relative to the REPO ROOT (derived from this module's own location), never
// process.cwd() — so state loads identically whether launched from a shell or Task Scheduler, from
// any working directory (directive-11). The repo root is found by walking up to the nearest
// package.json, which is stable regardless of where this file sits in the build output (src/ or dist/).

let cached: string | null = null

export function repoRoot(): string {
  if (cached) return cached
  const start = dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      cached = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  cached = dirname(start) // fallback: one level up from src/ | dist/
  return cached
}

export function repoPath(...segments: string[]): string {
  return join(repoRoot(), ...segments)
}
