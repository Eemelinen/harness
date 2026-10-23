import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { cleanState, formatCleanState, isStateFile } from '../src/clean-state'
import { loadProject } from '../src/config'

const list = (status: string) => ({
  project: 'fixture',
  last_updated: '2026-10-23',
  rules: {
    single_active_feature: true,
    passing_requires_evidence: true,
    do_not_skip_verification: true,
  },
  status_legend: { not_started: 'a', in_progress: 'b', blocked: 'c', passing: 'd' },
  features: [
    {
      id: 'F-001',
      priority: 1,
      area: 'x',
      title: 'x',
      user_visible_behavior: 'x',
      status,
      depends_on: [],
      verification: ['L1: pnpm check'],
      evidence: status === 'passing' ? ['ok'] : [],
      attempts: 0,
      notes: '',
    },
  ],
})

function git(dir: string, ...args: string[]) {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8' },
  )
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

function write(dir: string, file: string, content: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  writeFileSync(path.join(dir, file), content)
}

/** A committed project on `main` plus a feature branch checked out. */
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-clean-'))
  git(dir, 'init', '-q', '-b', 'main')
  write(
    dir,
    'harness.config.json',
    JSON.stringify({
      generator: { model: 'opus' },
      evaluator: { model: 'opus' },
      cleanState: {
        checks: [
          {
            name: 'no .only/.skip added under tests/',
            kind: 'added',
            paths: ['tests'],
            pattern: '\\.(only|skip)\\(',
            message: 'a .only/.skip was added under tests/',
          },
          {
            name: 'coverage thresholds untouched',
            kind: 'removed',
            paths: ['vitest.config.ts'],
            pattern: '(lines|functions|branches|statements):\\s*[0-9]+',
            message: 'a coverage threshold was removed or changed',
          },
        ],
        files: [
          {
            file: 'AGENTS.md',
            mustContain: ['<!-- BEGIN:x -->', '<!-- END:x -->'],
            name: 'AGENTS.md marker block intact',
            message: 'AGENTS.md is missing the marker block',
          },
        ],
      },
    }),
  )
  write(dir, 'feature_list.json', JSON.stringify(list('in_progress'), null, 2))
  write(dir, 'PROGRESS.md', '# Progress\n')
  write(dir, 'AGENTS.md', '<!-- BEGIN:x -->\n<!-- END:x -->\n')
  write(dir, 'vitest.config.ts', 'thresholds: { lines: 80 }\n')
  write(dir, 'init.sh', 'exit 0\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  git(dir, 'checkout', '-q', '-b', 'feat/F-001')
  return dir
}

const failures = (dir: string, options = {}) =>
  cleanState(loadProject(dir), { quick: true, ...options })
    .lines.filter((l) => l.status === 'fail')
    .map((l) => l.text)

describe('clean-state', () => {
  it('fails a dirty tree unless only state files changed and --allow-state-dirty is set', () => {
    const dir = fixture()
    write(dir, 'PROGRESS.md', '# Progress\nsession 2\n')
    expect(failures(dir)[0]).toMatch(/working tree is dirty/)
    expect(failures(dir, { allowStateDirty: true })).not.toContainEqual(
      expect.stringMatching(/uncommitted/),
    )
    write(dir, 'src/app.ts', 'x')
    expect(failures(dir, { allowStateDirty: true })).toContain(
      'uncommitted changes outside the state files:',
    )
  })

  it('runs the configured diff and file checks against the base branch', () => {
    const dir = fixture()
    write(dir, 'tests/a.test.ts', 'it.only("x", () => {})\n')
    write(dir, 'vitest.config.ts', 'thresholds: {}\n')
    write(dir, 'AGENTS.md', 'no markers\n')
    write(dir, 'PROGRESS.md', '# Progress\nupdated\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'work')
    expect(failures(dir)).toEqual([
      'a .only/.skip was added under tests/',
      'a coverage threshold was removed or changed',
      'AGENTS.md is missing the marker block',
    ])
  })

  it('requires PROGRESS.md on the branch and a terminal status with --require-terminal', () => {
    const dir = fixture()
    write(dir, 'src/app.ts', 'x\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'work')
    expect(failures(dir, { requireTerminal: true })).toEqual([
      'F-001 is still in_progress; run /harness:verify-feature or mark it blocked before stopping',
      'PROGRESS.md was not updated on this branch (Current Verified State, session entry, Next Steps)',
    ])
  })

  it('runs the restart path unless --quick', () => {
    const dir = fixture()
    const result = cleanState(loadProject(dir), {})
    expect(result.lines.at(-1)).toEqual({ status: 'ok', text: 'FAST=1 ./init.sh exits 0' })
    expect(formatCleanState(result, false)).toMatch(
      /^clean-state check \(base: main, branch: feat\/F-001\)/,
    )
  })

  it('treats directory entries in stateFiles as prefixes', () => {
    const stateFiles = ['feature_list.json', 'PROGRESS.md', 'docs/harness/']
    expect(isStateFile('docs/harness/session-handoff.md', stateFiles)).toBe(true)
    expect(isStateFile('PROGRESS.md', stateFiles)).toBe(true)
    expect(isStateFile('docs/README.md', stateFiles)).toBe(false)
  })
})
