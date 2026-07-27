import { execFileSync } from 'node:child_process'
import type { GitSignal } from './types.js'

// Git watcher: emits a signal for a commit or branch event over the bion repo (dogfood).
// Reactive dispatch does not trigger on git events in this cut — the git watcher only records
// events (extensible later). Real collection via readGitHead(); tests construct signals directly.

export function commitSignal(branch: string, sha: string): GitSignal {
  return { kind: 'git', event: 'commit', branch, sha }
}

export function branchSignal(branch: string, sha: string): GitSignal {
  return { kind: 'git', event: 'branch', branch, sha }
}

/** Read the current HEAD (branch + sha) from a git working tree. */
export function readGitHead(cwd: string): { branch: string; sha: string } {
  const run = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  return { branch: run(['rev-parse', '--abbrev-ref', 'HEAD']), sha: run(['rev-parse', 'HEAD']) }
}
