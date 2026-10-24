import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { projectCommands, regressions, selftest, type Check } from '../src/selftest'

const repo = path.resolve(import.meta.dirname, '..')

describe('projectCommands', () => {
  it('takes the literal commands of allow entries and verification steps', () => {
    expect(
      projectCommands(
        [
          'Bash(pnpm check*)',
          'Bash(pnpm harness:*)',
          'Bash(git commit *)',
          'Bash(docker compose * up)',
          'Read',
          'Bash(pnpm check)',
        ],
        ['L1: pnpm test:unit', 'L3: pnpm test:e2e', 'manual: click around'],
      ),
    ).toEqual(['pnpm check', 'pnpm harness', 'git commit', 'pnpm test:unit', 'pnpm test:e2e'])
  })
})

describe('regressions', () => {
  const check = (name: string, ok: boolean): Check => ({ name, ok, detail: '' })

  it('names checks that fail now but did not fail before', () => {
    const before = [check('a', true), check('b', false), check('c', true)]
    const after = [check('a', false), check('b', false), check('c', true), check('d', false)]
    expect(regressions(before, after).map((c) => c.name)).toEqual(['a', 'd'])
  })

  it('treats a version without selftest as all-pass', () => {
    expect(regressions([], [check('a', false)]).map((c) => c.name)).toEqual(['a'])
  })
})

describe('selftest', () => {
  it('passes on the harness repository', { timeout: 120_000 }, () => {
    const failed = selftest(repo).filter((c) => !c.ok)
    expect(failed).toEqual([])
  })

  it('reports a guard rule that blocks a command the project allows', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-selftest-'))
    writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","private":true}\n')
    copyFileSync(
      path.join(repo, 'templates', 'feature_list.json'),
      path.join(dir, 'feature_list.json'),
    )
    writeFileSync(
      path.join(dir, 'harness.config.json'),
      JSON.stringify({
        project: { name: 'Fixture' },
        generator: { model: 'm' },
        evaluator: { model: 'm' },
        allowedTools: ['Bash(pnpm lint)'],
        guard: {
          bash: [{ pattern: 'pnpm lint', atCommandStart: true, reason: 'lint runs in CI only' }],
        },
      }),
    )
    const checks = selftest(dir)
    const byName = new Map(checks.map((c) => [c.name, c]))
    expect(byName.get('guard allows: pnpm lint')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('lint runs in CI only'),
    })
    expect(byName.get('guard allows: pnpm check')?.ok).toBe(true)
    expect(checks.filter((c) => c.name.startsWith('guard blocks:')).every((c) => c.ok)).toBe(true)
    expect(byName.get('generator prompt renders')?.ok).toBe(true)
  })

  it('stops at a config that does not load', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-selftest-bad-'))
    writeFileSync(path.join(dir, 'harness.config.json'), '{"generator":{}}')
    const checks = selftest(dir)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ name: 'config loads', ok: false })
  })
})
