import { describe, it, expect } from 'vitest'
import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveEnvPath, repoRoot, repoPath } from '../src/index.js'

// directive-11: .env.local must resolve module-relative (repo root), NOT process.cwd() — so the
// Task-Scheduler-launched daemon (cwd ≠ repo) still loads BION_DATABASE_URL + BION_NTFY_URL.
describe('env loading is cwd-independent (directive-11)', () => {
  it('resolveEnvPath points at the repo-root .env.local regardless of cwd, and both vars load', () => {
    const orig = process.cwd()
    const elsewhere = mkdtempSync(join(tmpdir(), 'bion-cwd-'))
    try {
      process.chdir(elsewhere) // simulate Task Scheduler's foreign cwd
      const p = resolveEnvPath()
      expect(p).toBe(repoPath('.env.local'))
      expect(p.replace(/\\/g, '/')).toMatch(/\/repo\/\.env\.local$/)
      expect(existsSync(p)).toBe(true)

      // load from that path into a clean object (never touches real process.env)
      const loaded: Record<string, string> = {}
      config({ path: p, processEnv: loaded })
      expect(loaded.BION_DATABASE_URL, 'DB url must load from a foreign cwd').toBeTruthy()
      expect(loaded.BION_NTFY_URL, 'ntfy url must load from a foreign cwd').toBeTruthy()
    } finally {
      process.chdir(orig)
    }
  })

  it('repoRoot resolves to the directory that holds package.json', () => {
    expect(existsSync(join(repoRoot(), 'package.json'))).toBe(true)
  })
})
