import { readFileSync } from 'node:fs'
import type { TestSignal } from './types.js'

// Test-output watcher: normalizes a vitest JSON reporter result into a TestSignal.
// Real usage: `vitest run --reporter=json --outputFile=<f>` then readVitestResultFile(<f>, meta).

interface VitestAssertion {
  fullName?: string
  title?: string
  status: string
}
interface VitestFileResult {
  name?: string
  assertionResults?: VitestAssertion[]
}
export interface VitestJson {
  numTotalTests?: number
  numFailedTests?: number
  numPassedTests?: number
  testResults?: VitestFileResult[]
}

export interface RunMeta {
  branch: string
  runId: string
}

export function parseVitestJson(raw: VitestJson, meta: RunMeta): TestSignal {
  const total = raw.numTotalTests ?? 0
  const failed = raw.numFailedTests ?? 0
  const failedTests: string[] = []
  for (const f of raw.testResults ?? []) {
    for (const a of f.assertionResults ?? []) {
      if (a.status === 'failed') failedTests.push(a.fullName ?? a.title ?? f.name ?? 'unnamed')
    }
  }
  return {
    kind: 'test',
    branch: meta.branch,
    passed: failed === 0,
    failed,
    total,
    failedTests,
    runId: meta.runId,
  }
}

export function readVitestResultFile(path: string, meta: RunMeta): TestSignal {
  return parseVitestJson(JSON.parse(readFileSync(path, 'utf8')) as VitestJson, meta)
}
