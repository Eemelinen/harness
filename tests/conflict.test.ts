import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { abortMerge, mergeDefaultBranch, type BaseMergeSpec } from '../src/conflict'
import { render, waitForMerge } from '../src/loop'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function commit(cwd: string, file: string, text: string, message: string) {
  writeFileSync(path.join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', message)
}

function identity(cwd: string) {
  git(cwd, 'config', 'user.name', 'Test')
  git(cwd, 'config', 'user.email', 'test@example.com')
  git(cwd, 'config', 'commit.gpgsign', 'false')
}

/**
 * A bare `origin`, the driver's checkout on main, a feature worktree on feat/F-001 (pushed), and a
 * second clone that moves main the way another PR's merge does.
 */
function repo() {
  const top = mkdtempSync(path.join(tmpdir(), 'harness-conflict-'))
  const origin = path.join(top, 'origin.git')
  const root = path.join(top, 'root')
  const dir = path.join(top, 'F-001')
  const other = path.join(top, 'other')
  git(top, 'init', '-q', '--bare', '-b', 'main', origin)
  git(top, 'clone', '-q', origin, root)
  identity(root)
  commit(root, 'spatial.ts', 'export const a = 1\n', 'init')
  git(root, 'push', '-q', 'origin', 'main')
  git(root, 'worktree', 'add', '-q', '-b', 'feat/F-001', dir, 'main')
  git(top, 'clone', '-q', origin, other)
  identity(other)
  const spec: BaseMergeSpec = {
    dir,
    root,
    remote: 'origin',
    defaultBranch: 'main',
    branch: 'feat/F-001',
    check: ['sh', '-c', 'echo checked > checked.txt'],
  }
  const remoteHead = (ref: string) => git(origin, 'rev-parse', ref)
  return { top, origin, root, dir, other, spec, remoteHead }
}

function featureAndMain(
  r: ReturnType<typeof repo>,
  feature: string,
  main: string,
  file = 'spatial.ts',
) {
  commit(r.dir, 'spatial.ts', feature, 'feat(F-001): add b')
  git(r.dir, 'push', '-q', '-u', 'origin', 'feat/F-001')
  commit(r.other, file, main, 'feat(F-002): add c')
  git(r.other, 'push', '-q', 'origin', 'main')
}

describe('mergeDefaultBranch', () => {
  it('merges a clean change, runs the check and pushes the branch', () => {
    const r = repo()
    featureAndMain(
      r,
      'export const a = 1\nexport const b = 2\n',
      'export const c = 3\n',
      'other.ts',
    )
    const logs: string[] = []
    const result = mergeDefaultBranch(r.spec, (l) => logs.push(l))
    expect(result.state).toBe('pushed')
    if (result.state !== 'pushed') return
    expect(r.remoteHead('feat/F-001')).toBe(result.head)
    expect(git(r.dir, 'log', '-1', '--format=%s')).toBe(
      'chore(harness): merge origin/main into feat/F-001',
    )
    expect(existsSync(path.join(r.dir, 'other.ts'))).toBe(true)
    expect(existsSync(path.join(r.dir, 'checked.txt'))).toBe(true)
    // The driver's default branch follows, so the merge gate diffs only this branch's change.
    expect(git(r.root, 'rev-parse', 'main')).toBe(r.remoteHead('main'))
    expect(logs.some((l) => l.includes('running sh -c'))).toBe(true)
  })

  it('leaves a conflicting merge in progress and names the files', () => {
    const r = repo()
    featureAndMain(
      r,
      'export const a = 1\nexport const b = 2\n',
      'export const a = 1\nexport const c = 3\n',
    )
    const before = r.remoteHead('feat/F-001')
    const result = mergeDefaultBranch(r.spec)
    expect(result).toEqual({ state: 'conflicts', files: ['spatial.ts'] })
    expect(readFileSync(path.join(r.dir, 'spatial.ts'), 'utf8')).toContain('<<<<<<<')
    expect(git(r.dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBe(r.remoteHead('main'))
    expect(existsSync(path.join(r.dir, 'checked.txt'))).toBe(false)
    expect(r.remoteHead('feat/F-001')).toBe(before)
    // A give-up aborts it, so the worktree a human takes over is clean.
    expect(abortMerge(r.dir)).toBe(true)
    expect(git(r.dir, 'status', '--porcelain')).toBe('')
    expect(abortMerge(r.dir)).toBe(false)
  })

  it('keeps a clean merge that fails the check for a fixer, unpushed', () => {
    const r = repo()
    featureAndMain(
      r,
      'export const a = 1\nexport const b = 2\n',
      'export const c = 3\n',
      'other.ts',
    )
    const before = r.remoteHead('feat/F-001')
    const result = mergeDefaultBranch({
      ...r.spec,
      check: ['sh', '-c', 'echo "L1 broke" >&2; exit 3'],
    })
    expect(result).toEqual({ state: 'check-failed', output: 'L1 broke' })
    expect(git(r.dir, 'log', '-1', '--format=%s')).toContain('merge origin/main')
    expect(r.remoteHead('feat/F-001')).toBe(before)
  })

  it('gives up when the branch already contains the default branch', () => {
    const r = repo()
    commit(r.dir, 'spatial.ts', 'export const b = 2\n', 'feat(F-001): add b')
    git(r.dir, 'push', '-q', '-u', 'origin', 'feat/F-001')
    expect(mergeDefaultBranch(r.spec)).toEqual({
      state: 'failed',
      reason: 'GitHub reports a conflict, but feat/F-001 already contains origin/main',
    })
  })

  it('gives up when the default branch cannot be fetched', () => {
    const r = repo()
    const result = mergeDefaultBranch({ ...r.spec, remote: 'nowhere' })
    expect(result.state).toBe('failed')
    if (result.state === 'failed') expect(result.reason).toMatch(/^git fetch failed/)
  })
})

describe('waitForMerge with gh stubbed', () => {
  let stub: string
  const savedPath = process.env.PATH
  const savedStub = process.env.GH_STUB

  /** `gh pr view` answers view-<n>.json on the n-th call, then view.json; `gh pr checks` has none. */
  beforeEach(() => {
    stub = mkdtempSync(path.join(tmpdir(), 'harness-gh-'))
    const bin = path.join(stub, 'bin')
    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        'if [ "$2" = "checks" ]; then echo "[]"; exit 0; fi',
        'n=$(cat "$GH_STUB/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$GH_STUB/n"',
        'f="$GH_STUB/view-$n.json"; [ -f "$f" ] || f="$GH_STUB/view.json"; cat "$f"',
        '',
      ].join('\n'),
    )
    chmodSync(path.join(bin, 'gh'), 0o755)
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`
    process.env.GH_STUB = stub
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    process.env.PATH = savedPath
    if (savedStub === undefined) delete process.env.GH_STUB
    else process.env.GH_STUB = savedStub
  })

  const view = (name: string, info: object) =>
    writeFileSync(path.join(stub, `${name}.json`), JSON.stringify({ state: 'OPEN', ...info }))
  const calls = () => Number(readFileSync(path.join(stub, 'n'), 'utf8'))

  it('returns conflict at once when GitHub reports CONFLICTING', async () => {
    view('view', { mergeable: 'CONFLICTING', headRefOid: 'abc' })
    await expect(waitForMerge('pr/1', true, new Set(), 'abc')).resolves.toEqual({
      state: 'conflict',
    })
    expect(calls()).toBe(1)
  })

  it('keeps waiting while mergeable is UNKNOWN', async () => {
    view('view-1', { mergeable: 'UNKNOWN', headRefOid: 'abc' })
    view('view', { state: 'MERGED', mergeable: 'UNKNOWN', headRefOid: 'abc' })
    const waited = waitForMerge('pr/1', true, new Set(), 'abc')
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(waited).resolves.toEqual({ state: 'merged' })
    expect(calls()).toBe(2)
  })

  it('ignores a conflict GitHub reported for an older head', async () => {
    view('view-1', { mergeable: 'CONFLICTING', headRefOid: 'old' })
    view('view', { mergeable: 'CONFLICTING', headRefOid: 'new' })
    const waited = waitForMerge('pr/1', true, new Set(), 'new')
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(waited).resolves.toEqual({ state: 'conflict' })
    expect(calls()).toBe(2)
  })

  it('leaves a conflict to the human when the PR waits for a human merge', async () => {
    view('view-1', { mergeable: 'CONFLICTING', headRefOid: 'abc' })
    view('view', { state: 'MERGED', headRefOid: 'abc' })
    const waited = waitForMerge('pr/1', false, new Set())
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(waited).resolves.toEqual({ state: 'merged' })
  })
})

describe('prompts/conflict-fixer.md', () => {
  it('has a value for every placeholder and asks to keep both sides', () => {
    const template = readFileSync(
      path.resolve(import.meta.dirname, '../prompts/conflict-fixer.md'),
      'utf8',
    )
    const keys = [
      'PROJECT_NAME',
      'PROJECT_NOTES',
      'FEATURE_ID',
      'FEATURE_TITLE',
      'PR',
      'ATTEMPT',
      'MAX_ATTEMPTS',
      'BASE',
      'PROBLEM',
      'CONTEXT',
    ]
    const used = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
    expect(new Set(used)).toEqual(new Set(keys))
    const text = render(template, Object.fromEntries(keys.map((k) => [k, 'x'])))
    expect(text).not.toMatch(/\{\{/)
    expect(text).toContain('Keep both sides')
    expect(text).toMatch(/CI-FIX-VERDICT: \{"classification": "fixed" \| "out_of_scope"/)
  })
})
