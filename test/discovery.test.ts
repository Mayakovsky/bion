import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverRepos } from '../src/index.js'

// discoverRepos() coverage (directive-68) — replaces the GREY_REPO_PATH/static-list pattern with
// dev-root-wide auto-discovery. A bare `.git` directory (no real git init) is enough here: the
// function only checks for its existence, never runs git against it.

function freshDevRoot(): string {
  const dir = join(tmpdir(), `bion-devroot-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeFlatRepo(devRoot: string, name: string): void {
  mkdirSync(join(devRoot, name, '.git'), { recursive: true }) // grey-shaped: .git at its own root
}

function makeNestedRepo(devRoot: string, name: string, inner = 'repo'): void {
  mkdirSync(join(devRoot, name, inner, '.git'), { recursive: true }) // bion-shaped: .git one level below
}

describe('discoverRepos — flat and nested shapes', () => {
  it('finds a flat repo (grey-shaped) and a nested repo (bion-shaped) in the same pass', () => {
    const devRoot = freshDevRoot()
    makeFlatRepo(devRoot, 'grey')
    makeNestedRepo(devRoot, 'bion')

    const repos = discoverRepos(devRoot, { ignorePath: join(devRoot, 'no-such-ignore-file') })
    const byName = Object.fromEntries(repos.map((r) => [r.name, r.path]))
    expect(byName['grey']).toBe(join(devRoot, 'grey'))
    expect(byName['bion']).toBe(join(devRoot, 'bion', 'repo'))
  })
})

describe('discoverRepos — non-repo directories', () => {
  it('skips a directory with no .git at itself or one level below', () => {
    const devRoot = freshDevRoot()
    mkdirSync(join(devRoot, 'not-a-repo', 'some-file-dir'), { recursive: true })
    writeFileSync(join(devRoot, 'not-a-repo', 'notes.md'), 'x')

    const repos = discoverRepos(devRoot, { ignorePath: join(devRoot, 'no-such-ignore-file') })
    expect(repos.find((r) => r.name === 'not-a-repo')).toBeUndefined()
  })
})

describe('discoverRepos — .bion/bionignore', () => {
  it('excludes a repo whose name matches a bionignore pattern, leaving others untouched', () => {
    const devRoot = freshDevRoot()
    makeFlatRepo(devRoot, 'grey')
    makeFlatRepo(devRoot, 'secrets-vault')
    const ignorePath = join(devRoot, '.bion', 'bionignore')
    mkdirSync(join(devRoot, '.bion'), { recursive: true })
    writeFileSync(ignorePath, 'secrets-vault\n')

    const repos = discoverRepos(devRoot, { ignorePath })
    expect(repos.find((r) => r.name === 'secrets-vault')).toBeUndefined()
    expect(repos.find((r) => r.name === 'grey')).toBeTruthy()
  })

  it('defaults to excluding nothing when bionignore is absent', () => {
    const devRoot = freshDevRoot()
    makeFlatRepo(devRoot, 'grey')

    const repos = discoverRepos(devRoot, { ignorePath: join(devRoot, '.bion', 'bionignore') })
    expect(repos.find((r) => r.name === 'grey')).toBeTruthy()
  })

  it('supports a `*` wildcard pattern', () => {
    const devRoot = freshDevRoot()
    makeFlatRepo(devRoot, 'scratch-1')
    makeFlatRepo(devRoot, 'scratch-2')
    makeFlatRepo(devRoot, 'grey')
    const ignorePath = join(devRoot, '.bion', 'bionignore')
    mkdirSync(join(devRoot, '.bion'), { recursive: true })
    writeFileSync(ignorePath, 'scratch-*\n')

    const repos = discoverRepos(devRoot, { ignorePath })
    expect(repos.find((r) => r.name === 'scratch-1')).toBeUndefined()
    expect(repos.find((r) => r.name === 'scratch-2')).toBeUndefined()
    expect(repos.find((r) => r.name === 'grey')).toBeTruthy()
  })
})

describe('discoverRepos — mid-run addition', () => {
  it('picks up a repo added to the tree between two discovery passes, no restart needed', () => {
    const devRoot = freshDevRoot()
    makeFlatRepo(devRoot, 'grey')
    const opts = { ignorePath: join(devRoot, 'no-such-ignore-file') }

    const first = discoverRepos(devRoot, opts)
    expect(first.find((r) => r.name === 'benthic')).toBeUndefined()

    makeFlatRepo(devRoot, 'benthic') // simulates a repo appearing mid-run

    const second = discoverRepos(devRoot, opts)
    expect(second.find((r) => r.name === 'benthic')?.path).toBe(join(devRoot, 'benthic'))
    expect(second.find((r) => r.name === 'grey')).toBeTruthy() // still finds the original too
  })
})
