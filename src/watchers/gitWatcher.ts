import { execFileSync } from 'node:child_process'
import type { GitSignal } from './types.js'
import { handleGitSignal } from './handler.js'

// Git watcher: emits a signal for a commit or branch event over any watched repo (directive-27 —
// was bion-only/dogfood; now multi-repo). Reactive dispatch does not trigger on git events in this
// cut — the git watcher only records events (extensible later). Real collection via readGitHead();
// tests construct signals directly.

export function commitSignal(repo: string, branch: string, sha: string): GitSignal {
  return { kind: 'git', event: 'commit', repo, branch, sha }
}

export function branchSignal(repo: string, branch: string, sha: string): GitSignal {
  return { kind: 'git', event: 'branch', repo, branch, sha }
}

/** Read the current HEAD (branch + sha) from a git working tree. */
export function readGitHead(cwd: string): { branch: string; sha: string } {
  const run = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  return { branch: run(['rev-parse', '--abbrev-ref', 'HEAD']), sha: run(['rev-parse', 'HEAD']) }
}

export interface RepoRef {
  /** Short label used in signals/events — never the filesystem path (keeps paths out of event
   *  payloads, and is what handleGitSignal namespaces its dedup key by). */
  name: string
  path: string
}

/** Per-repo last-seen sha, keyed by repo NAME (matching GitSignal.repo). One state map per
 *  poller — the daemon holds one for its process lifetime, same lifetime the old module-level
 *  `lastSha` had before this was multi-repo. */
export type GitPollState = Map<string, string>

export function createGitPollState(): GitPollState {
  return new Map()
}

/**
 * Poll each watched repo's HEAD once; emit + record a commit signal for any repo whose sha moved.
 * One repo's failure (bad path, git unavailable, not a repo) is isolated to that repo — the same
 * try/catch isolation the single-repo poller always had, now per-repo instead of global.
 */
export async function pollGit(repos: RepoRef[], state: GitPollState): Promise<void> {
  for (const repo of repos) {
    try {
      const { branch, sha } = readGitHead(repo.path)
      if (sha !== state.get(repo.name)) {
        await handleGitSignal(commitSignal(repo.name, branch, sha))
        state.set(repo.name, sha)
      }
    } catch {
      /* not a git repo / git unavailable / bad path — skip this repo only, others still poll */
    }
  }
}
