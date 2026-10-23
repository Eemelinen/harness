import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  decideCiFix,
  describeChecks,
  isFailed,
  logExcerpt,
  parseChecks,
  parseFixVerdict,
  runIds,
} from '../src/ci'
import { render } from '../src/loop'

// The shape `gh pr checks --json name,bucket,link,workflow` returned for Metsävahti PR #3.
const checksJson = JSON.stringify([
  {
    name: 'Lint · typecheck · unit · integration · build',
    bucket: 'fail',
    link: 'https://github.com/o/r/actions/runs/1834/job/5521',
    workflow: 'CI',
  },
  {
    name: 'E2E (Playwright)',
    bucket: 'skipping',
    link: 'https://github.com/o/r/actions/runs/1834/job/5522',
    workflow: 'CI',
  },
])

describe('parseChecks', () => {
  it('reads the checks and the run id from the job link', () => {
    const checks = parseChecks(checksJson)
    expect(checks.map((c) => [c.name, c.bucket, c.runId])).toEqual([
      ['Lint · typecheck · unit · integration · build', 'fail', '1834'],
      ['E2E (Playwright)', 'skipping', '1834'],
    ])
    expect(checks.filter(isFailed).map((c) => c.name)).toEqual([
      'Lint · typecheck · unit · integration · build',
    ])
    expect(runIds(checks)).toEqual(['1834'])
    expect(describeChecks(checks.filter(isFailed))).toMatch(/workflow "CI"\): fail https:/)
  })

  it('treats gh errors and empty output as no checks', () => {
    expect(parseChecks('no checks reported on the feat/F-001 branch')).toEqual([])
    expect(parseChecks('')).toEqual([])
  })

  it('counts cancelled jobs as failed', () => {
    expect(isFailed({ name: 'x', bucket: 'cancel', link: '', workflow: '' })).toBe(true)
    expect(isFailed({ name: 'x', bucket: 'pending', link: '', workflow: '' })).toBe(false)
  })
})

describe('logExcerpt', () => {
  const prefix = (line: string) =>
    `build\tBuild (Turbopack)\t2026-10-23T09:14:02.1234567Z \u001b[31m${line}\u001b[0m`
  const noise = Array.from({ length: 300 }, (_, i) => prefix(`compiling module ${i}`))
  const failure = [
    'Error: Failed to collect configuration for /kirjaudu',
    '  [cause]: Error: auth: limit must be ≥ 1',
    '    at createRateLimiter (src/lib/rate-limit.ts:196)',
  ].map(prefix)
  const log = [...noise.slice(0, 150), ...failure, ...noise.slice(150)].join('\n')

  it('keeps the error lines with context and the tail, without prefixes or colours', () => {
    const text = logExcerpt(log)
    expect(text).toContain('Error: Failed to collect configuration for /kirjaudu')
    expect(text).toContain('auth: limit must be ≥ 1')
    expect(text).toContain('at createRateLimiter (src/lib/rate-limit.ts:196)')
    expect(text).toContain('compiling module 299')
    expect(text).not.toContain('compiling module 100\n')
    expect(text).not.toMatch(/\u001b|\t|2026-10-23T/)
    expect(text).toContain('…')
  })

  it('keeps head and tail when the excerpt is over the cap', () => {
    const text = logExcerpt(log, { maxChars: 400 })
    expect(text.length).toBeLessThan(450)
    expect(text).toContain('(trimmed)')
    expect(text).toContain('compiling module 299')
  })
})

describe('parseFixVerdict', () => {
  it('prefers structured output', () => {
    expect(
      parseFixVerdict({ structured_output: { classification: 'flaky', reason: 'runner died' } }),
    ).toEqual({ classification: 'flaky', reason: 'runner died' })
  })

  it('reads the last verdict line of the result text', () => {
    const result =
      'Done.\nCI-FIX-VERDICT: {"classification": "fixed", "reason": "limit is read lazily"}'
    expect(parseFixVerdict({ result })).toEqual({
      classification: 'fixed',
      reason: 'limit is read lazily',
    })
  })

  it('falls back to the classification word on a malformed line', () => {
    expect(parseFixVerdict({ result: '`CI-FIX-VERDICT: out_of_scope (main is red)`' })).toEqual({
      classification: 'out_of_scope',
      reason: '',
    })
  })

  it('returns undefined without a verdict line', () => {
    expect(parseFixVerdict({ result: 'I fixed it.' })).toBeUndefined()
    expect(parseFixVerdict(undefined)).toBeUndefined()
  })
})

describe('decideCiFix', () => {
  const fixed = { classification: 'fixed' as const, reason: '' }
  const flaky = { classification: 'flaky' as const, reason: '' }
  const base = { status: 'passing' as const, newCommits: 0, postCheckOk: true, rerunDone: false }

  it('gives up when the session blocked the feature, whatever it claims', () => {
    expect(decideCiFix({ ...base, status: 'blocked', newCommits: 1, verdict: fixed })).toBe(
      'give-up',
    )
  })

  it('evaluates a verified new commit and retries a bad state', () => {
    expect(decideCiFix({ ...base, newCommits: 1, verdict: fixed })).toBe('evaluate')
    expect(decideCiFix({ ...base, newCommits: 2, verdict: flaky })).toBe('evaluate')
    expect(decideCiFix({ ...base, newCommits: 1, postCheckOk: false })).toBe('retry')
  })

  it('re-runs a flaky failure once', () => {
    expect(decideCiFix({ ...base, verdict: flaky })).toBe('rerun')
    expect(decideCiFix({ ...base, verdict: flaky, rerunDone: true })).toBe('retry')
  })

  it('gives up on out of scope and retries a session that did nothing', () => {
    expect(decideCiFix({ ...base, verdict: { classification: 'out_of_scope', reason: '' } })).toBe(
      'give-up',
    )
    expect(decideCiFix({ ...base, verdict: fixed })).toBe('retry')
    expect(decideCiFix(base)).toBe('retry')
  })
})

describe('prompts/ci-fixer.md', () => {
  it('has a value for every placeholder', () => {
    const template = readFileSync(
      path.resolve(import.meta.dirname, '../prompts/ci-fixer.md'),
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
      'FAILED_CHECKS',
      'LOG_EXCERPT',
      'BASE',
      'CONTEXT',
    ]
    const used = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
    expect(new Set(used)).toEqual(new Set(keys))
    const text = render(template, Object.fromEntries(keys.map((k) => [k, 'x'])))
    expect(text).not.toMatch(/\{\{/)
  })
})
